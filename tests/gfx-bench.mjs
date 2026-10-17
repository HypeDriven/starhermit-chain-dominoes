// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// screen, starts a 4-player Practice table and keeps playing legal moves through the visible hand
// and end buttons (tile flights, steam, window shimmer and the post chain all run).
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => !!window.__CD_UI, null, { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#screen-settings.active');
  await page.locator('#set-quality').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings .btn-back').click();
}

async function move(page) {
  const st = await page.evaluate(() => {
    const g = window.__CD_UI && window.__CD_UI.game;
    if (!g || !g.state) return { phase: 'no-game' };
    const s = g.state;
    if (s.phase !== 'active') return { phase: s.phase };
    const me = g._humanIndex();
    if (s.turn !== me) return { phase: 'ai-turn' };
    const acts = window.ChainDominoesRules.legalActions(s, me);
    const play = acts.find((a) => a.type === 'play');
    if (play) return { phase: 'mine', kind: 'play', end: play.end, idx: s.hands[me].indexOf(play.tileId) };
    if (acts.find((a) => a.type === 'draw')) return { phase: 'mine', kind: 'draw' };
    if (acts.find((a) => a.type === 'pass')) return { phase: 'mine', kind: 'pass' };
    return { phase: 'none' };
  });
  if (st.phase === 'mine') {
    if (st.kind === 'play') {
      await page.locator('#hand-list .domino').nth(st.idx).click({ timeout: 1000 });
      await page.click(`#btn-end-${st.end}`, { timeout: 1000 });
    } else await page.click(st.kind === 'draw' ? '#btn-draw' : '#btn-pass', { timeout: 1000 });
  } else if (st.phase !== 'ai-turn' && st.phase !== 'no-game') {
    // Round or match over: continue to the next round, or retry the match.
    if (await page.locator('#btn-next-round:visible').count()) await page.click('#btn-next-round', { timeout: 1000 });
    else if (await page.locator('#btn-results-retry:visible').count()) await page.click('#btn-results-retry', { timeout: 1000 });
  }
}

export async function start(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#screen-setup.active');
  await page.selectOption('#setup-body select >> nth=0', '4');
  await page.click('#btn-take-seat');
  await page.waitForSelector('#screen-game.active', { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await move(page); await page.waitForTimeout(300); } catch { if (!open) return; }
    }
  })();
  await page.waitForTimeout(500);
}
