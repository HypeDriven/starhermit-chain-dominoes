'use strict';
/* Probe 3: theme switch, mobile portrait + landscape game layouts. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: 9223, path, method: method || 'GET' }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}
(async () => {
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=9223', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const targets = await httpJson('/json/list');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params) => { const i = ++id; return new Promise(r => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }); };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) console.error('EVAL ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (p) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(r.result.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:8571/index.html' });
  await sleep(3000);

  // midnight theme + 4-player practice for a busy board
  await ev(`__CD_UI.store.settings.theme = 'midnight-espresso'; __CD_UI.store.saveNow(); __CD_UI._applySettingsClasses();`);
  await ev(`(() => {
    const C = window.ChainDominoesContent;
    const cfg = C.practiceConfig({ players: 4, difficulty: 'medium', targetScore: 100, seed: 'probe4' }, 'Guest');
    __CD_UI._startMatch('practice', { id: 'practice', name: 'Practice' }, cfg);
  })()`);
  await sleep(4000);
  // fast-forward a few AI turns & play if possible
  await ev(`(async () => {
    const ui = window.__CD_UI, g = ui.game, R = window.ChainDominoesRules;
    let guard = 0;
    while (guard++ < 10 && g.state.phase === 'active') {
      const me = g.state.players.findIndex(p => p.kind === 'human');
      if (g.state.turn === me) {
        const acts = R.legalActions(g.state, me);
        g.act(acts.find(a => a.type === 'play') || acts[0], 'p3-' + guard + Date.now());
      }
      await new Promise(r => setTimeout(r, 150));
      guard++;
    }
  })()`);
  await sleep(1200);
  await shot('tests/shots/theme-midnight-4p.png');

  // portrait mobile
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(800);
  await shot('tests/shots/mobile-portrait-game.png');
  console.log('portrait overflow:', await ev('document.documentElement.scrollWidth'));

  // landscape mobile
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(800);
  await shot('tests/shots/mobile-landscape-game.png');
  console.log('landscape sizes ok');
  chrome.kill();
})().catch(e => { console.error(e); process.exit(1); });
