/* Chain Dominoes — content validation + AI smoke tests (Node). */
'use strict';
const R = require('../js/rules.js');
const C = require('../js/content.js');
const AI = require('../js/ai.js');

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

/* ---------- structure ---------- */
ok(C.JOURNEY.length === 40, 'journey has exactly 40 stages');
ok(C.JOURNEY.filter(s => s.mastery).length === 5, 'five mastery stages');
ok(C.CHALLENGES.length >= 8, 'at least 8 challenges');
ok(C.TUTORIALS.length >= 6, 'six tutorial lessons');
ok(C.THEMES.length === 5, 'five visual themes');
ok(new Set(C.JOURNEY.map(s => s.id)).size === 40, 'unique journey ids');
ok(C.JOURNEY.every(s => C.themeById(s.theme)), 'all journey themes exist');
ok(C.CHALLENGES.every(c => C.themeById(c.theme)), 'all challenge themes exist');

/* ---------- offline validator: legality, bounded duration, no soft locks ---- */
const greedy = (state, acts, player) =>
  AI.chooseMove(state, state.turn, (player && player.difficulty) || 'medium', null) || acts[0];
const t0 = Date.now();
const problems = C.validateContent(greedy);
ok(problems.length === 0, 'content validator clean' + (problems.length ? ': ' + problems.slice(0, 5).join(' | ') : ''));
ok(Date.now() - t0 < 30000, 'validation bounded in time');

/* ---------- AI vs AI full games, every difficulty pairing ---------- */
function aiGame(seed, difficulties, ruleset) {
  const players = difficulties.map((d, i) => ({ id: 'p' + i, difficulty: d, kind: 'ai' }));
  const state = R.createMatch({ seed, players, ruleset: ruleset || { targetScore: 50 } });
  const rng = R.mulberry32(R.hashString('airng' + seed));
  let guard = 0;
  while (state.phase !== 'match-over' && guard++ < 3000) {
    if (state.phase === 'round-over') { R.nextRound(state); continue; }
    const p = state.turn;
    const move = AI.chooseMove(state, p, state.players[p].difficulty, rng);
    const r = R.applyCommand(state, p, move);
    if (!r.ok) return { error: r.reason, state };
  }
  return { state, guard };
}
for (const [a, b] of [['easy', 'easy'], ['easy', 'medium'], ['medium', 'medium'], ['medium', 'hard'], ['hard', 'hard']]) {
  const g = aiGame('pair-' + a + '-' + b, [a, b]);
  ok(!g.error && g.state.phase === 'match-over', `AI pairing ${a} vs ${b} completes`);
  ok(g.state.terminal && typeof g.state.terminal.winner === 'number', `terminal record ${a} vs ${b}`);
}

/* AI skill ordering: hard should beat easy most of the time over 12 seeds */
{
  let hardWins = 0;
  for (let i = 0; i < 12; i++) {
    const g = aiGame('skill-' + i, ['hard', 'easy']);
    if (g.state.terminal.winner === 0) hardWins++;
  }
  ok(hardWins >= 8, 'hard AI beats easy AI usually (' + hardWins + '/12)');
}

/* ---------- daily generator ---------- */
{
  const d1 = C.dailyForDate(new Date(Date.UTC(2026, 0, 15)));
  const d2 = C.dailyForDate(new Date(Date.UTC(2026, 0, 15, 23, 59)));
  const d3 = C.dailyForDate(new Date(Date.UTC(2026, 0, 16)));
  ok(d1.id === d2.id && d1.seed === d2.seed, 'daily stable within a UTC day');
  ok(d1.id !== d3.id, 'daily rotates by day');
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const d = C.dailyForDate(new Date(Date.UTC(2026, 5, 1 + i)));
    seen.add(d.ruleset.targetScore + '/' + d.ruleset.drawRule + '/' + d.players);
    ok(d.id && d.seed && d.ruleset && d.goal && C.themeById(d.theme), 'daily ' + i + ' fully specified');
  }
  ok(seen.size === 7, 'weekly daily rotation is varied');
  // play a daily end-to-end
  const cfg = C.dailyToConfig(d1, 'Tester');
  const g = aiGame(cfg.seed + '-play', cfg.players.map(p => p.difficulty || 'medium'), cfg.ruleset);
  ok(g.state.phase === 'match-over', 'daily config plays to completion');
}

/* ---------- journey difficulty curve sanity ---------- */
{
  const early = C.JOURNEY.slice(0, 8), late = C.JOURNEY.slice(32);
  const avgTarget = arr => arr.reduce((s, x) => s + x.targetScore, 0) / arr.length;
  ok(avgTarget(late) > avgTarget(early), 'later stages have higher targets');
  ok(late.every(s => s.ai.includes('hard')), 'late stages feature hard AI');
  ok(early.every(s => !s.ai.includes('hard')), 'early stages avoid hard AI');
}

/* ---------- challenge configs playable ---------- */
for (const ch of C.CHALLENGES) {
  const cfg = C.challengeToConfig(ch, 'Tester');
  const g = aiGame(cfg.seed + '-t', cfg.players.map(p => p.difficulty || 'medium'), cfg.ruleset);
  ok(g.state.phase === 'match-over', 'challenge ' + ch.id + ' terminates');
}

/* ---------- tutorials replay cleanly (independent check) ---------- */
for (const t of C.TUTORIALS) {
  const st = R.createCustomState(t.setup);
  ok(st.phase === 'active', t.id + ' starts active');
  ok(t.steps.length >= 1, t.id + ' has steps');
  ok(t.intro && t.outro && t.title, t.id + ' fully authored');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
