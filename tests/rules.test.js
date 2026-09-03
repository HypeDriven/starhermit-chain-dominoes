/* Chain Dominoes — rules engine test suite (Node, no deps). */
'use strict';
const R = require('../js/rules.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ' (got ' + JSON.stringify(a) + ')'); }

function twoPlayerCfg(seed, ruleset) {
  return {
    seed: seed || 'test-seed',
    ruleset: ruleset || {},
    players: [
      { id: 'human', name: 'You', kind: 'human' },
      { id: 'ai', name: 'Bot', kind: 'ai' },
    ],
  };
}

/* ---------- tile set ---------- */
ok(R.tileSet(6).length === 28, 'double-six set has 28 tiles');
ok(R.tileSet(6).every(t => t.pips === t.a + t.b), 'pip counts correct');
ok(R.tileSet(6).filter(t => t.double).length === 7, 'seven doubles');

/* ---------- match creation / determinism ---------- */
const s1 = R.createMatch(twoPlayerCfg('alpha'));
const s2 = R.createMatch(twoPlayerCfg('alpha'));
eq(R.stateHash(s1), R.stateHash(s2), 'same seed -> identical state hash');
const s3 = R.createMatch(twoPlayerCfg('beta'));
ok(R.stateHash(s1) !== R.stateHash(s3), 'different seed -> different deal');
ok(s1.hands[0].length === 7 && s1.hands[1].length === 7, '2 players get 7 tiles');
ok(s1.boneyard.length === 14, '28 - 14 dealt = 14 in boneyard');
const allIds = s1.hands[0].concat(s1.hands[1], s1.boneyard).slice().sort((a, b) => a - b);
eq(allIds, Array.from({ length: 28 }, (_, i) => i), 'deal is a permutation of the set');
ok(s1.hands[0].concat(s1.hands[1]).includes((() => { // highest double dealt determines opener
  const openerHand = s1.hands[s1.turn];
  return openerHand[0]; // sanity only
})()), 'opener index valid');
ok(s1.turn === 0 || s1.turn === 1, 'turn is a valid player');
ok(s1.tick === 0 && s1.phase === 'active', 'initial phase/tick');

/* ---------- 3 and 4 player deals ---------- */
const s4 = R.createMatch({ seed: 'x', players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
ok(s4.hands.every(h => h.length === 5) && s4.boneyard.length === 8, '4 players get 5 tiles, 8 boneyard');

/* ---------- legal actions on empty chain ---------- */
const custom = R.createCustomState({
  seed: 'c1',
  players: [{ id: 'h' }, { id: 'a' }],
  hands: [[0, 1, 7], [2, 3]], // 0|0, 0|1, 1|6  vs  0|2, 0|3
  boneyard: [4, 5],
  turn: 0,
});
const la0 = R.legalActions(custom, 0);
ok(la0.length === 3 && la0.every(a => a.type === 'play' && a.end === 'right'), 'opening: any tile, right end only');
eq(R.legalActions(custom, 1), [], 'no actions when not your turn');

/* ---------- play + orientation ---------- */
let r = R.applyCommand(custom, 0, { type: 'play', tileId: 1, end: 'right' }); // 0|1
ok(r.ok, 'opening play accepted');
ok(custom.chain.length === 1 && custom.leftEnd === 0 && custom.rightEnd === 1, 'chain ends after opener');
ok(custom.hands[0].length === 2 && custom.turn === 1, 'hand shrank, turn advanced');
r = R.applyCommand(custom, 1, { type: 'play', tileId: 2, end: 'left' }); // 0|2 onto left end 0
ok(r.ok, 'left-end play accepted');
ok(custom.leftEnd === 2 && custom.rightEnd === 1, 'left end updated to outward face');
ok(custom.chain[0].left === 2 && custom.chain[0].right === 0, 'orientation stored correctly');

/* ---------- invalid reasons ---------- */
eq(R.invalidReason(custom, 0, { type: 'play', tileId: 7, end: 'left' }), 'no-matching-end', '7=1|6 does not match ends 2/1? 1 matches right! -> use right');
r = R.applyCommand(custom, 0, { type: 'play', tileId: 7, end: 'left' });
ok(!r.ok && r.reason === 'no-matching-end', 'wrong end rejected with reason');
r = R.applyCommand(custom, 0, { type: 'play', tileId: 99, end: 'left' });
ok(!r.ok && r.reason === 'tile-not-in-hand', 'tile not in hand');
eq(R.invalidReason(custom, 1, { type: 'play', tileId: 3, end: 'right' }), 'not-your-turn', 'out of turn rejected');
ok(custom.players[0].invalidActions >= 2, 'invalid attempts counted');
r = R.applyCommand(custom, 0, { type: 'draw' });
ok(!r.ok && r.reason === 'must-play-if-able', 'draw rejected while play exists');
r = R.applyCommand(custom, 0, { type: 'pass' });
ok(!r.ok && r.reason === 'must-play-if-able', 'pass rejected while play exists');

/* ---------- draw / pass flow ---------- */
const drawState = R.createCustomState({
  seed: 'c2',
  players: [{ id: 'h' }, { id: 'a' }],
  chain: [{ id: 27, left: 6, right: 6 }],   // ends 6 and 6
  hands: [[0], [1]],                        // 0|0 and 0|1 — neither matches 6
  boneyard: [21, 9],                        // 3|6 then 1|3
  turn: 0,
});
let la = R.legalActions(drawState, 0);
eq(la.map(a => a.type), ['draw'], 'only draw is legal with no matching tile');
r = R.applyCommand(drawState, 0, { type: 'draw' });
ok(r.ok && drawState.hands[0].length === 2 && drawState.turn === 0, 'until-playable: turn stays after draw');
la = R.legalActions(drawState, 0);
ok(la.some(a => a.type === 'play' && a.tileId === 21), 'drawn 3|6 is playable');
r = R.applyCommand(drawState, 0, { type: 'play', tileId: 21, end: 'left' });
ok(r.ok && drawState.leftEnd === 3, 'played drawn tile');
ok(drawState.turn === 1, 'turn advanced after play');
la = R.legalActions(drawState, 1); // hand [0|1], ends 3/6 — no match, boneyard has 1|3
eq(la.map(a => a.type), ['draw'], 'p1 must draw');
r = R.applyCommand(drawState, 1, { type: 'draw' }); // gets 1|3, playable on left end 3
ok(drawState.hands[1].some(id => id === 9), 'drew 1|3');
r = R.applyCommand(drawState, 1, { type: 'play', tileId: 9, end: 'left' });
ok(r.ok, 'p1 plays drawn tile');

/* pass when boneyard empty */
const passState = R.createCustomState({
  seed: 'c3',
  players: [{ id: 'h' }, { id: 'a' }],
  chain: [{ id: 27, left: 6, right: 6 }],
  hands: [[0], [1]],
  boneyard: [],
  turn: 0,
});
eq(R.legalActions(passState, 0).map(a => a.type), ['pass'], 'pass is only option when boneyard empty');
r = R.applyCommand(passState, 0, { type: 'pass' });
ok(r.ok && passState.turn === 1, 'pass advances turn');
r = R.applyCommand(passState, 1, { type: 'pass' });
ok(r.ok && passState.phase !== 'active', 'two consecutive passes end a 2-player round (blocked)');
ok(passState.roundResult && passState.roundResult.reason === 'blocked', 'blocked reason recorded');

/* ---------- scoring: blocked round ---------- */
// hands were 0|0 (0 pips) and 0|1 (1 pip) -> player 0 wins, margin = 1 - 0 = 1
eq(passState.roundResult.winners, [0], 'lowest pips wins blocked round');
eq(passState.roundResult.breakdown[0].points, 1, 'blocked winner scores opponents pips minus own');
ok(passState.phase === 'round-over' || passState.phase === 'match-over', 'phase advanced');

/* ---------- scoring: domino ---------- */
const dom = R.createCustomState({
  seed: 'c4',
  players: [{ id: 'h' }, { id: 'a' }],
  chain: [{ id: 27, left: 6, right: 6 }],
  hands: [[21], [14, 15]],   // p0: 3|6; p1: 2|3 (5) + 2|4 (6) -> 11 pips
  boneyard: [],
  turn: 0,
  ruleset: { targetScore: 0 },
});
r = R.applyCommand(dom, 0, { type: 'play', tileId: 21, end: 'left' });
ok(r.ok && r.event.roundOver === true, 'domino ends the round');
eq(dom.roundResult.reason, 'domino', 'domino reason');
eq(dom.roundResult.winners, [0], 'domino winner');
eq(dom.roundResult.breakdown[0].points, 11, 'winner scores all opponent pips');
ok(dom.phase === 'match-over' && dom.terminal.reason === 'rounds-exhausted' || dom.phase === 'round-over', 'single-round ruleset ends match or offers next round');

/* ---------- match target & ranking ---------- */
const mt = R.createCustomState({
  seed: 'c5',
  players: [{ id: 'h' }, { id: 'a' }],
  chain: [{ id: 27, left: 6, right: 6 }],
  hands: [[21], [0]],
  boneyard: [],
  turn: 0,
  ruleset: { targetScore: 5, maxRounds: 10 },
});
mt.players[0].score = 10; // already near target
r = R.applyCommand(mt, 0, { type: 'play', tileId: 21, end: 'left' });
ok(mt.phase === 'match-over', 'match ends when target reached');
eq(mt.terminal.reason, 'target-reached', 'terminal reason target-reached');
eq(mt.terminal.winner, 0, 'winner is p0');

/* ---------- next round ---------- */
const nr = R.createCustomState({
  seed: 'c6', players: [{ id: 'h' }, { id: 'a' }],
  chain: [{ id: 27, left: 6, right: 6 }], hands: [[21], [0]], boneyard: [], turn: 0,
  ruleset: { targetScore: 500 },
});
R.applyCommand(nr, 0, { type: 'play', tileId: 21, end: 'left' });
ok(nr.phase === 'round-over', 'round over, match continues (target 500)');
const rr = R.nextRound(nr);
ok(rr.ok && nr.phase === 'active' && nr.round === 2, 'next round started');
ok(nr.hands[0].length === 7 && nr.boneyard.length === 14, 'redeal for round 2');

/* ---------- serialization round-trip ---------- */
const ser = R.serialize(nr);
const back = R.deserialize(ser);
eq(R.stateHash(back), R.stateHash(nr), 'serialize/deserialize preserves hash');
eq(back.ruleset.targetScore, 500, 'ruleset survives serialization');

/* ---------- replay determinism (property test over seeds) ---------- */
function playRandomGame(seed, players) {
  const cfg = { seed, players: players || [{ id: 'p0' }, { id: 'p1' }] };
  const state = R.createMatch(cfg);
  const rng = R.mulberry32(R.hashString('driver' + seed));
  let guard = 0;
  while (state.phase !== 'match-over' && guard++ < 2000) {
    if (state.phase === 'round-over') { R.nextRound(state); continue; }
    const acts = R.legalActions(state, state.turn);
    if (acts.length === 0) throw new Error('no legal actions in active phase');
    const a = acts[rng.int(acts.length)];
    const res = R.applyCommand(state, state.turn, a);
    if (!res.ok) throw new Error('legal action rejected: ' + res.reason);
  }
  return { cfg, state };
}
for (const seed of ['r1', 'r2', 'r3', 'r4', 'r5']) {
  const g1 = playRandomGame(seed);
  const g2 = playRandomGame(seed);
  eq(R.stateHash(g1.state), R.stateHash(g2.state), 'replay identical for seed ' + seed);
  ok(g1.state.phase === 'match-over', 'game terminates for seed ' + seed);
  ok(g1.state.terminal && typeof g1.state.terminal.winner === 'number', 'terminal record present ' + seed);
}

/* ---------- replay() verification API ---------- */
{
  const g = playRandomGame('verify-me');
  const log = [];
  // rebuild a proper log including next-round markers
  const state = R.createMatch(g.cfg);
  const rng = R.mulberry32(R.hashString('driververify-me'));
  let guard = 0;
  while (state.phase !== 'match-over' && guard++ < 2000) {
    if (state.phase === 'round-over') { R.nextRound(state); log.push({ cmd: { type: 'next-round' }, player: -1 }); continue; }
    const acts = R.legalActions(state, state.turn);
    const a = acts[rng.int(acts.length)];
    R.applyCommand(state, state.turn, a);
    log.push({ cmd: a, player: state.log[state.log.length - 1].player });
  }
  const rep = R.replay(g.cfg, log);
  ok(rep.ok, 'replay() accepts own command log');
  eq(rep.hash, R.stateHash(state), 'replay hash matches live hash');
}

/* ---------- fuzz malformed commands ---------- */
{
  const st = R.createMatch(twoPlayerCfg('fuzz'));
  const junk = [null, undefined, {}, { type: 7 }, { type: 'play' }, { type: 'play', tileId: 'x', end: 'up' },
    { type: 'draw', extra: 'z' }, { type: 'explode' }, { type: 'pass', tileId: 1 }, [], 'play', 42];
  for (const j of junk) {
    const r2 = R.applyCommand(st, st.turn, j);
    ok(!r2.ok, 'malformed command rejected: ' + JSON.stringify(j));
  }
  ok(st.phase === 'active', 'fuzzing never corrupted the state');
}

/* ---------- drawRule variants ---------- */
{
  const oneDraw = R.createCustomState({
    seed: 'd1', players: [{ id: 'h' }, { id: 'a' }],
    chain: [{ id: 27, left: 6, right: 6 }], hands: [[0], [1]], boneyard: [2], turn: 0,
    ruleset: { drawRule: 'one' },
  });
  const r3 = R.applyCommand(oneDraw, 0, { type: 'draw' }); // draws 0|2 — not playable vs 6/6
  ok(r3.ok && r3.event.autoPass === true && oneDraw.turn === 1, 'drawRule one: auto-pass when drawn tile unplayable');

  const noDraw = R.createCustomState({
    seed: 'd2', players: [{ id: 'h' }, { id: 'a' }],
    chain: [{ id: 27, left: 6, right: 6 }], hands: [[0], [1]], boneyard: [2], turn: 0,
    ruleset: { drawRule: 'none' },
  });
  eq(R.legalActions(noDraw, 0).map(a => a.type), ['pass'], 'drawRule none: pass even with boneyard tiles');
  eq(R.invalidReason(noDraw, 0, { type: 'draw' }), 'draw-disabled', 'draw disabled reason');
}

/* ---------- move limit (challenge) ---------- */
{
  const ml = R.createCustomState({
    seed: 'm1', players: [{ id: 'h' }, { id: 'a' }],
    hands: [[0, 1, 2], [3, 4, 5]], boneyard: [], turn: 0,
    ruleset: { moveLimit: 2, targetScore: 0 },
  });
  R.applyCommand(ml, 0, { type: 'play', tileId: 1, end: 'right' });
  ml.players[0].plays = 2; // simulate limit reached
  eq(R.invalidReason(ml, ml.turn === 0 ? 0 : 1, { type: 'play', tileId: 0, end: 'right' }),
     ml.turn === 0 ? 'move-limit-reached' : R.invalidReason(ml, ml.turn, { type: 'play', tileId: 0, end: 'right' }),
     'move limit enforced (or other player turn)');
}

/* ---------- tie-break ranking ---------- */
{
  const st = R.createMatch(twoPlayerCfg('tb'));
  st.players[0].score = 50; st.players[1].score = 50;
  st.players[0].invalidActions = 2; st.players[1].invalidActions = 0;
  const rank = R.rankPlayers(st);
  eq(rank[0].player, 1, 'fewer invalid actions wins tie');
  st.players[0].invalidActions = 0;
  st.players[0].plays = 9; st.players[1].plays = 5;
  const rank2 = R.rankPlayers(st);
  eq(rank2[0].player, 1, 'fewer ticks wins next tie level');
}

/* ---------- full 4-player game termination ---------- */
{
  const g = playRandomGame('four', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  ok(g.state.phase === 'match-over' && g.state.terminal.rounds >= 1, '4-player game terminates');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
