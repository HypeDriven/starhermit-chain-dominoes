'use strict';
const { spawn, execSync } = require('child_process');
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
    if (r.result && r.result.exceptionDetails) return 'EX: ' + JSON.stringify(r.result.exceptionDetails);
    return r.result && r.result.result ? r.result.result.value : JSON.stringify(r.result);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:8571/index.html' });
  await sleep(3000);
  console.log('ui:', await ev('!!window.__CD_UI'));
  await ev('document.getElementById("btn-journey").click()');
  await sleep(300);
  await ev('document.querySelector("#journey-list .journey-item").click()');
  await sleep(2500);
  console.log('renderer:', await ev('!!__CD_UI.renderer'));
  console.log('canvas size:', await ev('JSON.stringify({w: document.getElementById("glcanvas").width, h: document.getElementById("glcanvas").height, cw: document.getElementById("glcanvas").clientWidth, ch: document.getElementById("glcanvas").clientHeight})'));
  console.log('info:', await ev('JSON.stringify(__CD_UI.renderer.renderer.info.render)'));
  console.log('cam pos:', await ev('JSON.stringify(__CD_UI.renderer.camera.position)'));
  console.log('camT:', await ev('__CD_UI.renderer._camT'));
  console.log('scene children:', await ev('__CD_UI.renderer.scene.children.length'));
  console.log('tiles:', await ev('__CD_UI.renderer.tileMeshes.size'));
  console.log('running:', await ev('__CD_UI.renderer._running'));
  console.log('gl ctx lost:', await ev('__CD_UI.renderer.renderer.getContext().isContextLost()'));
  // play several moves so the chain builds, then select a tile
  console.log('midgame:', await ev(`(async () => {
    const ui = window.__CD_UI, g = ui.game, R = window.ChainDominoesRules;
    let guard = 0;
    while (guard++ < 14) {
      if (g.state.phase !== 'active') break;
      const me = g.state.players.findIndex(p => p.kind === 'human');
      if (g.state.turn !== me) { await new Promise(r => setTimeout(r, 250)); continue; }
      const acts = R.legalActions(g.state, me);
      const play = acts.find(a => a.type === 'play');
      const a = play || acts[0];
      g.act(a, 'probe-' + guard + '-' + Date.now());
      await new Promise(r => setTimeout(r, 120));
    }
    // select first playable tile for marker/ghost display
    const me = g.state.players.findIndex(p => p.kind === 'human');
    while (g.state.phase === 'active' && g.state.turn !== me) await new Promise(r => setTimeout(r, 200));
    // draw until a play exists, then select it
    let g2 = 0;
    while (g.state.phase === 'active' && g2++ < 20) {
      const acts = R.legalActions(g.state, me);
      const play = acts.find(a => a.type === 'play');
      if (play) { g.selectTile(play.tileId); break; }
      const d = acts.find(a => a.type === 'draw');
      if (!d) break;
      g.act(d, 'probe-draw-' + g2);
      while (g.state.phase === 'active' && g.state.turn !== me) await new Promise(r => setTimeout(r, 200));
    }
    await new Promise(r => setTimeout(r, 900));
    return JSON.stringify({ chain: g.state.chain.length, ends: [g.state.leftEnd, g.state.rightEnd], turn: g.state.turn, phase: g.state.phase });
  })()`));
  console.log('markers:', await ev(`JSON.stringify({
      L: __CD_UI.renderer.endMarkers.left.visible, R: __CD_UI.renderer.endMarkers.right.visible,
      Lpos: __CD_UI.renderer.endMarkers.left.position.toArray(),
      sel: __CD_UI.game.selectedTile,
      legalEnds: __CD_UI.game.buildView().legalEnds,
      myTurn: __CD_UI.game.buildView().myTurn,
      capLhidden: document.getElementById('btn-end-left').classList.contains('hidden'),
      capRhidden: document.getElementById('btn-end-right').classList.contains('hidden'),
      capLtext: document.getElementById('btn-end-left').textContent,
    })`));
  console.log('info2:', await ev('JSON.stringify(__CD_UI.renderer.renderer.info.render)'));
  // force render one frame synchronously and read pixels
  console.log('pixel probe:', await ev(`(() => {
    const r = __CD_UI.renderer;
    r.renderer.render(r.scene, r.camera);
    const gl = r.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth/2), Math.floor(gl.drawingBufferHeight/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px).join(',');
  })()`));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/shots/probe.png', Buffer.from(shot.result.data, 'base64'));
  chrome.kill();
})().catch(e => { console.error(e); process.exit(1); });
