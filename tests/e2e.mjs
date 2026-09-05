/**
 * Chain Dominoes — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible on-screen UI in system Chrome via playwright-core:
 *   title → journey list → stage 1 → plays real moves by clicking hand tiles
 *   and the on-screen end caps / Draw / Pass buttons until the match results
 *   overlay → retry → pause/resume → leave match → settings open/toggle/close.
 * Runs twice: desktop 1280×800 and a fresh mobile context 390×844 (touch).
 *
 * Game state (window.__CD_UI) is READ only for synchronization (whose turn,
 * legal actions); every action goes through DOM controls a player sees.
 *
 * The repo's server.js is a StarHermit authoritative game script (not a static
 * file server), so this test embeds its own minimal node:http static server on
 * an ephemeral port. Everything is torn down in `finally`.
 *
 * Run: npm run test:e2e
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'video/mp2t', '.txt': 'text/plain',
};
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader|deprecated|three\.min\.js/i;

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const step = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function playOneHumanTurn(page, tag) {
  // Read state for sync; return the UI action to take this iteration.
  const st = await page.evaluate(() => {
    const ui = window.__CD_UI, g = ui && ui.game;
    if (!g || !g.state) return { phase: 'no-game' };
    const s = g.state;
    if (s.phase !== 'active') return { phase: s.phase };
    const me = s.players.findIndex(p => p.kind === 'human');
    if (s.turn !== me) return { phase: 'ai-turn' };
    const acts = window.ChainDominoesRules.legalActions(s, me);
    const play = acts.find(a => a.type === 'play');
    if (play) return { phase: 'my-turn', kind: 'play', end: play.end, idx: s.hands[me].indexOf(play.tileId) };
    if (acts.find(a => a.type === 'draw')) return { phase: 'my-turn', kind: 'draw' };
    if (acts.find(a => a.type === 'pass')) return { phase: 'my-turn', kind: 'pass' };
    return { phase: 'my-turn', kind: 'none' };
  });
  if (st.phase !== 'my-turn') return st.phase;
  if (st.kind === 'play') {
    await page.locator('#hand-list .domino').nth(st.idx).click();       // select tile
    const cap = `#btn-end-${st.end}`;
    await page.waitForSelector(`${cap}:not(.hidden)`, { timeout: 4000 });
    await page.click(cap);                                              // commit to an end
    return 'played';
  }
  if (st.kind === 'draw') { await page.click('#btn-draw'); return 'draw'; }
  if (st.kind === 'pass') { await page.click('#btn-pass'); return 'pass'; }
  return 'none';
}

async function runPass(label, viewport, hasTouch) {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const ctx = await browser.newContext({ viewport, hasTouch });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const SHOT = (n) => `/tmp/chain-dominoes-e2e-${n}-${label}.png`;

    await step(`[${label}] load + title visible`, async () => {
      await page.goto(BASE + '/index.html', { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__CD_UI, null, { timeout: 10000 });
      await page.waitForSelector('#screen-title.active', { timeout: 10000 });
      if (!(await page.locator('#btn-quick-play').isVisible())) throw new Error('Play button not visible');
      await page.screenshot({ path: SHOT('title') });
    });

    await step(`[${label}] journey list (40 stages, stage 1 unlocked)`, async () => {
      await page.click('#btn-journey');
      await page.waitForSelector('#screen-journey.active');
      const total = await page.locator('#journey-list .journey-item').count();
      if (total !== 40) throw new Error(`expected 40 stages, got ${total}`);
      const unlocked = await page.locator('#journey-list .journey-item:not(.locked)').count();
      if (unlocked < 1) throw new Error('no journey stage unlocked');
      await page.screenshot({ path: SHOT('journey') });
    });

    await step(`[${label}] start journey stage 1`, async () => {
      await page.locator('#journey-list .journey-item:not(.locked)').first().click();
      await page.waitForSelector('#screen-game.active', { timeout: 15000 });
      await page.waitForFunction(() => !!window.__CD_UI.game?.state, null, { timeout: 15000 });
      await page.screenshot({ path: SHOT('game-start') });
    });

    let moves = 0, rounds = 0, resultsSeen = false, shotMid = false;
    await step(`[${label}] play full match through on-screen controls`, async () => {
      for (let i = 0; i < 500 && !resultsSeen; i++) {
        const r = await playOneHumanTurn(page, label);
        if (r === 'played' || r === 'draw' || r === 'pass') {
          moves++;
          if (!shotMid && moves >= 3) { shotMid = true; await page.screenshot({ path: SHOT('midgame') }); }
        } else if (r === 'round-over') {
          rounds++;
          await page.waitForSelector('#overlay-round:not(.hidden)', { timeout: 8000 });
          if (rounds === 1) await page.screenshot({ path: SHOT('round-over') });
          await page.click('#btn-next-round');
        } else if (r === 'match-over') {
          await page.waitForSelector('#overlay-results:not(.hidden)', { timeout: 8000 });
          resultsSeen = true;
        } else if (r === 'no-game') {
          throw new Error('game session disappeared mid-match');
        }
        await sleep(260); // let AI turns / animations run
      }
      if (moves < 3) throw new Error(`human made only ${moves} moves through the UI`);
      if (!resultsSeen) throw new Error('match never reached the results overlay');
      console.log(`  moves: ${moves}, rounds: ${rounds}`);
    });

    await step(`[${label}] results overlay with breakdown`, async () => {
      const rows = await page.locator('#results-breakdown .row').count();
      if (rows < 1) throw new Error('results breakdown is empty');
      console.log(`  breakdown rows: ${rows}`);
      await page.screenshot({ path: SHOT('results') });
    });

    await step(`[${label}] retry restarts the match`, async () => {
      await page.click('#btn-results-retry');
      await page.waitForSelector('#screen-game.active', { timeout: 15000 });
      await page.waitForFunction(() => window.__CD_UI.game?.state?.phase === 'active', null, { timeout: 15000 });
    });

    await step(`[${label}] pause + resume`, async () => {
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.screenshot({ path: SHOT('pause') });
      await page.click('#btn-resume');
      await page.waitForSelector('#overlay-pause.hidden', { state: 'attached' });
    });

    await step(`[${label}] leave match back to title`, async () => {
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-leave-match');
      await page.waitForSelector('#screen-title.active');
    });

    await step(`[${label}] settings open, toggles apply, close`, async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#screen-settings.active');
      await page.click('#set-motion');
      if (!(await page.evaluate(() => document.body.classList.contains('reduced-motion'))))
        throw new Error('reduced motion not applied');
      await page.click('#set-motion');
      await page.click('#set-contrast');
      if (!(await page.evaluate(() => document.body.classList.contains('high-contrast'))))
        throw new Error('high contrast not applied');
      await page.click('#set-contrast');
      await page.screenshot({ path: SHOT('settings') });
      await page.locator('#screen-settings .btn-back').click();
      await page.waitForSelector('#screen-title.active');
    });

    await ctx.close();
  } finally {
    await browser.close();
  }
  const bad = errors.filter(e => !browserNoise.test(e));
  if (bad.length) throw new Error(`[${label}] page errors:\n` + bad.slice(0, 8).join('\n'));
}

try {
  await runPass('desktop', { width: 1280, height: 800 }, false);
  await runPass('mobile', { width: 390, height: 844 }, true);
  console.log('\nE2E PASS — chain-dominoes playable end-to-end on desktop and mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  server.close();
}
