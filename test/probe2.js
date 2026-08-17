'use strict';
/* Probe 2: WebGL fallback path, theme switch, mobile portrait/landscape game layouts. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 9223, path }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
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
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (p) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(r.result.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');

  /* ---- fallback: break WebGL before any page script runs ---- */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'const _gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(t){ if(String(t).includes("webgl")) return null; return _gc.call(this, t); };',
  });
  await send('Page.navigate', { url: 'http://localhost:8571/index.html' });
  await sleep(3000);
  await ev('document.getElementById("btn-journey").click()');
  await sleep(300);
  await ev('document.querySelector("#journey-list .journey-item").click()');
  await sleep(1500);
  console.log('fallback shown:', await ev('!document.getElementById("webgl-fallback").classList.contains("hidden")'));
  console.log('renderer null:', await ev('__CD_UI.renderer === null'));
  // game still playable via DOM
  const fb = await ev(`(async () => {
    const ui = window.__CD_UI, g = ui.game, R = window.ChainDominoesRules;
    let guard = 0;
    while (guard++ < 10) {
      if (g.state.phase !== 'active') return 'round-end';
      const me = g.state.players.findIndex(p => p.kind === 'human');
      if (g.state.turn !== me) { await new Promise(r => setTimeout(r, 250)); continue; }
      const acts = R.legalActions(g.state, me);
      const a = acts.find(x => x.type === 'play') || acts[0];
      g.act(a, 'fb-' + guard + Date.now());
      return 'played';
    }
    return 'stuck';
  })()`);
  console.log('fallback playable:', fb);
  await shot('test/shots/fallback.png');
  await ev('__CD_UI.leaveMatch()');
  await sleep(300);

  /* ---- theme switch + normal 3D ---- */
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'void 0' }); // no-op; old script persists per-target... navigate fresh target instead
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  console.log('--- NOTE: webgl override persists for this target; opening fresh target for themes ---');
  const t2 = await httpJson('/json/new?http://localhost:8571/index.html', 'PUT').catch(() => null);
  chrome.kill();
})();
