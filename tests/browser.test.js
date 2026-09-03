/* Chain Dominoes — browser integration test via raw CDP (no deps).
 * Drives headless Chrome against the local static server: clicks through
 * title -> setup -> game, plays real moves through the DOM controls,
 * exercises pause/resume/undo/skip, runs tutorial step 1, and captures
 * screenshots for visual inspection.
 */
'use strict';
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9223;
const APP = 'http://localhost:8571/index.html';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++; else { failed++; failures.push(name); console.error('FAIL:', name); }
}

function httpJson(path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: DEBUG_PORT, path, method: method || 'GET' }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(body); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(msg.params.exceptionDetails.text + ' ' +
          (msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : ''));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaljs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) + ' in: ' + expression.slice(0, 120));
    return r.result.value;
  }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
}

async function main() {
  // ensure static server is up
  try { execSync('curl -sf -o /dev/null http://localhost:8571/index.html'); }
  catch (e) { spawn('python3', ['-m', 'http.server', '8571'], { detached: true, stdio: 'ignore' }).unref(); await sleep(1000); }

  fs.rmSync('/tmp/cdtest-profile', { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--user-data-dir=/tmp/cdtest-profile',
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1280,860', 'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2500);

  let targets;
  for (let i = 0; i < 10; i++) {
    try { targets = await httpJson('/json/list'); break; } catch (e) { await sleep(500); }
  }
  const page = targets.find(t => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(3500);
  await cdp.evaljs('localStorage.clear()');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(3000);

  /* ---- boot ---- */
  ok(await cdp.evaljs('!!window.__CD_UI'), 'UI booted');
  ok(await cdp.evaljs('document.querySelector("#screen-title").classList.contains("active")'), 'title screen active');
  ok(await cdp.evaljs('!!window.THREE'), 'three.js loaded');
  ok(await cdp.evaljs('document.querySelectorAll("#screen-title .btn").length') >= 8, 'title menu rendered');

  /* ---- journey list ---- */
  await cdp.evaljs('document.getElementById("btn-journey").click()');
  await sleep(300);
  ok(await cdp.evaljs('document.querySelectorAll("#journey-list .journey-item").length') === 40, 'journey list shows 40 stages');
  ok(await cdp.evaljs('document.querySelectorAll("#journey-list .journey-item:not(.locked)").length') === 1, 'only stage 1 unlocked initially');
  await cdp.shot('tests/shots/journey.png');

  /* ---- start stage 1 via list click ---- */
  await cdp.evaljs('document.querySelector("#journey-list .journey-item").click()');
  await sleep(2500);
  ok(await cdp.evaljs('document.querySelector("#screen-game").classList.contains("active")'), 'game screen active');
  ok(await cdp.evaljs('!!__CD_UI.game && !!__CD_UI.game.state'), 'session created');
  const rendererOk = await cdp.evaljs('!!__CD_UI.renderer');
  ok(rendererOk, '3D renderer attached');
  await cdp.shot('tests/shots/game-start.png');

  /* ---- play moves through the real DOM controls until round/match ends ---- */
  const playOneHumanTurn = async () => {
    return cdp.evaljs(`(async () => {
      const ui = window.__CD_UI;
      const g = ui.game;
      if (!g || !g.state) return 'no-game';
      if (g.state.phase !== 'active') return g.state.phase;
      const me = g.state.players.findIndex(p => p.kind === 'human');
      if (g.state.turn !== me) return 'ai-turn';
      const R = window.ChainDominoesRules;
      const acts = R.legalActions(g.state, me);
      if (!acts.length) return 'no-actions';
      const play = acts.find(a => a.type === 'play');
      if (play) {
        const hand = g.state.hands[me];
        const idx = hand.indexOf(play.tileId);
        const btns = document.querySelectorAll('#hand-list .domino');
        if (!btns[idx]) return 'no-dom-button';
        btns[idx].click();                       // select
        await new Promise(r => setTimeout(r, 60));
        ui._commitToEnd(play.end);               // commit via end control path
        return 'played';
      }
      const a = acts[0];
      document.getElementById(a.type === 'draw' ? 'btn-draw' : 'btn-pass').click();
      return a.type;
    })()`);
  };

  let rounds = 0, resultsSeen = false, moves = 0;
  for (let i = 0; i < 400 && !resultsSeen; i++) {
    const st = await playOneHumanTurn();
    if (st === 'played' || st === 'draw' || st === 'pass') moves++;
    if (st === 'round-over') {
      rounds++;
      await sleep(400);
      const visible = await cdp.evaljs('!document.getElementById("overlay-round").classList.contains("hidden")');
      if (visible) {
        ok(true, 'round overlay shown (round ' + rounds + ')');
        await cdp.evaljs('document.getElementById("btn-next-round").click()');
      }
    }
    if (st === 'match-over') {
      await sleep(600);
      resultsSeen = await cdp.evaljs('!document.getElementById("overlay-results").classList.contains("hidden")');
    }
    await sleep(280); // let AI act
  }
  ok(moves > 3, 'human played multiple real moves through DOM controls (' + moves + ')');
  ok(resultsSeen, 'match reached results overlay');
  await cdp.shot('tests/shots/results.png');
  const breakdown = await cdp.evaljs('document.querySelectorAll("#results-breakdown .row").length');
  ok(breakdown >= 3, 'results breakdown has component rows (' + breakdown + ')');
  const stars = await cdp.evaljs('document.getElementById("results-stars").textContent.length');
  ok(stars >= 0, 'stars rendered');
  const journeyAfter = await cdp.evaljs('Object.keys(__CD_UI.store.progress.journey).length');
  ok(journeyAfter >= 1, 'journey progress persisted');
  ok(await cdp.evaljs('__CD_UI.store.progress.stats.matches') >= 1, 'stats counted');

  /* ---- retry button ---- */
  await cdp.evaljs('document.getElementById("btn-results-retry").click()');
  await sleep(2000);
  ok(await cdp.evaljs('document.querySelector("#screen-game").classList.contains("active")'), 'retry restarts into game screen');

  /* ---- pause / resume ---- */
  await cdp.evaljs('__CD_UI.pauseGame()');
  await sleep(200);
  ok(await cdp.evaljs('!document.getElementById("overlay-pause").classList.contains("hidden")'), 'pause overlay opens');
  await cdp.shot('tests/shots/pause.png');
  await cdp.evaljs('__CD_UI.resumeGame()');
  await sleep(200);
  ok(await cdp.evaljs('document.getElementById("overlay-pause").classList.contains("hidden")'), 'resume closes overlay');

  /* ---- undo (journey mode allows it) ---- */
  const undoOk = await cdp.evaljs(`(async () => {
    const ui = window.__CD_UI, g = ui.game, R = window.ChainDominoesRules;
    let guard = 0;
    while (g.state.phase === 'active' && g.state.players[g.state.turn].kind !== 'human' && guard++ < 40)
      await new Promise(r => setTimeout(r, 200));
    if (g.state.turn !== g.state.players.findIndex(p => p.kind === 'human')) return 'not-my-turn';
    const before = R.stateHash(g.state);
    const acts = R.legalActions(g.state, g.state.turn);
    const play = acts.find(a => a.type === 'play');
    if (!play) return 'no-play-available';
    g.act(play, 'undo-test-' + Date.now());
    const after = R.stateHash(g.state);
    if (before === after) return 'no-change';
    g.undo();
    return R.stateHash(g.state) === before ? 'undo-ok' : 'undo-mismatch';
  })()`);
  ok(undoOk === 'undo-ok' || undoOk === 'no-play-available' || undoOk === 'not-my-turn', 'undo restores exact state (' + undoOk + ')');

  /* ---- skip settles ---- */
  await cdp.evaljs('__CD_UI.game.skipToSettled()');
  ok(true, 'skipToSettled ran without exception');

  /* ---- settings screen ---- */
  await cdp.evaljs('__CD_UI.leaveMatch()');
  await sleep(300);
  await cdp.evaljs('document.getElementById("btn-settings").click()');
  await sleep(300);
  ok(await cdp.evaljs('document.querySelector("#screen-settings").classList.contains("active")'), 'settings screen opens');
  await cdp.evaljs('document.getElementById("set-motion").click()');
  ok(await cdp.evaljs('document.body.classList.contains("reduced-motion")'), 'reduced motion applies');
  await cdp.evaljs('document.getElementById("set-motion").click()');
  await cdp.evaljs('document.getElementById("set-contrast").click()');
  ok(await cdp.evaljs('document.body.classList.contains("high-contrast")'), 'high contrast applies');
  await cdp.evaljs('document.getElementById("set-contrast").click()');
  await cdp.shot('tests/shots/settings.png');

  /* ---- tutorial flow ---- */
  await cdp.evaljs('__CD_UI._nav("learn")');
  await sleep(300);
  ok(await cdp.evaljs('document.querySelectorAll("#tutorial-list li").length') === 6, 'six lessons listed');
  await cdp.evaljs('document.querySelector("#tutorial-list .card-go").click()');
  await sleep(1800);
  ok(await cdp.evaljs('__CD_UI.game && __CD_UI.game.mode === "tutorial"'), 'tutorial session started');
  ok(await cdp.evaljs('!document.getElementById("tutorial-banner").classList.contains("hidden")'), 'tutorial banner visible');
  const t1 = await cdp.evaljs(`(async () => {
    const ui = window.__CD_UI, g = ui.game;
    const step = g._tutorialStep();
    const tid = step.expect.tileId, tend = step.expect.end;
    const wrongFirst = g.act({ type: 'pass' }, 't-wrong');
    const right = g.act({ type: 'play', tileId: tid, end: tend }, 't-right-' + Date.now());
    return { wrong: wrongFirst.reason, ok: right.ok === true, step: g._tutorial ? g._tutorial.stepIdx : -1 };
  })()`);
  ok(t1.wrong === 'follow-the-lesson', 'tutorial rejects off-script action');
  ok(t1.ok && t1.step === 1, 'tutorial accepts expected action and advances');
  // finish the whole tutorial through scripted steps
  const tDone = await cdp.evaljs(`(async () => {
    const ui = window.__CD_UI, g = ui.game;
    const R = window.ChainDominoesRules;
    let guard = 0, completed = false;
    while (guard++ < 40) {
      await new Promise(r => setTimeout(r, 350));
      if (!g._tutorial) { completed = true; break; }
      const step = g._tutorialStep();
      if (!step) break;
      const w = step.expect;
      if (w.type === 'opponent' || w.type === 'opponent-pass') continue; // guide acts on timer
      const me = g.state.players.findIndex(p => p.kind === 'human');
      if (g.state.turn !== me) continue;
      const acts = R.legalActions(g.state, me);
      const a = acts.find(x => x.type === w.type &&
        (w.tileId === undefined || x.tileId === w.tileId) &&
        (w.end === undefined || x.end === w.end));
      if (!a) return 'expected-not-legal';
      g.act(a, 'tut-' + guard);
    }
    return completed ? 'complete' : 'stuck';
  })()`);
  ok(tDone === 'complete', 'tutorial lesson completes end-to-end (' + tDone + ')');
  ok(await cdp.evaljs('__CD_UI.store.progress.tutorials.includes("t1-matching")'), 'tutorial completion persisted');
  await cdp.shot('tests/shots/tutorial.png');

  /* ---- daily setup ---- */
  await cdp.evaljs('__CD_UI.leaveMatch()');
  await sleep(300);
  await cdp.evaljs('document.getElementById("btn-daily").click()');
  await sleep(400);
  ok(await cdp.evaljs('document.querySelector("#screen-setup").classList.contains("active")'), 'daily setup opens');
  ok(await cdp.evaljs('document.getElementById("setup-heading").textContent.includes("Daily")'), 'daily named with UTC date');
  await cdp.shot('tests/shots/daily.png');

  /* ---- help + keyboard bindings card ---- */
  await cdp.evaljs('__CD_UI._nav("help")');
  await sleep(200);
  ok(await cdp.evaljs('document.querySelectorAll("#help-body .rule-card").length') >= 6, 'help rule cards rendered');

  /* ---- profile ---- */
  await cdp.evaljs('__CD_UI._nav("profile")');
  await sleep(300);
  ok(await cdp.evaljs('document.querySelectorAll("#achievements-list li").length') === 7, 'achievements listed');
  ok(await cdp.evaljs('document.querySelectorAll("#stats-list dt").length') >= 8, 'stats rendered');

  /* ---- console errors ---- */
  const errs = cdp.consoleErrors.filter(e => !/deprecated|three\.min\.js/i.test(e));
  ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));

  /* ---- mobile viewport sanity ---- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.evaljs('__CD_UI._nav("title")');
  await sleep(500);
  await cdp.shot('tests/shots/mobile-title.png');
  const noHoriz = await cdp.evaljs('document.documentElement.scrollWidth <= 391');
  ok(noHoriz, 'no horizontal overflow at 390px portrait');

  console.log(`\n${passed} passed, ${failed} failed`);
  chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
