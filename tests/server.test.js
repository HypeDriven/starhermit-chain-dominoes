/* Chain Dominoes — authoritative server script tests (Node). */
'use strict';
const R = require('../js/rules.js');
const S = require('../server.js');

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

S._reset();

/* ---------- session lifecycle ---------- */
const c = S.createSession({
  sessionId: 's1', seed: 'server-seed',
  players: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
  ruleset: { targetScore: 20 }, turnDeadlineMs: 10000,
});
ok(c.ok && c.initialHash, 'session created with initial hash');

/* ---------- hidden information ---------- */
let snap = S.getSnapshot('s1', 'alice');
ok(snap.ok && Array.isArray(snap.publicState.yourHand), 'snapshot includes own hand');
ok(snap.publicState.players.every(p => typeof p.handCount === 'number'), 'opponent hands exposed only as counts');
ok(snap.publicState.yourHand.length === 7, 'own hand has 7 tiles');
const snapBob = S.getSnapshot('s1', 'bob');
ok(JSON.stringify(snapBob.publicState.yourHand) !== JSON.stringify(snap.publicState.yourHand), 'hands are private per player');
ok(!S.getSnapshot('s1', 'mallory').ok, 'non-member cannot snapshot');

/* ---------- command validation ---------- */
let r = S.submitCommand('s1', 'mallory', 'c1', { type: 'pass' });
ok(!r.ok && r.reason === 'not-a-member', 'non-member command rejected');
const turnIdx = snap.publicState.turn;
const turnId = snap.publicState.players[turnIdx].id;
const otherId = snap.publicState.players[1 - turnIdx].id;
r = S.submitCommand('s1', otherId, 'c2', { type: 'pass' });
ok(!r.ok && r.reason === 'not-your-turn', 'out-of-turn rejected');
r = S.submitCommand('s1', turnId, 'c3', { type: 'play', tileId: 999, end: 'left' });
ok(!r.ok && r.reason === 'tile-not-in-hand', 'out-of-bounds tile rejected');
r = S.submitCommand('s1', turnId, 'c4', 'garbage');
ok(!r.ok, 'malformed payload rejected');
r = S.submitCommand('s1', turnId, 'c5', { type: 'play', tileId: 1, end: 'left', pad: 'x'.repeat(600) });
ok(!r.ok && r.reason === 'payload-too-large', 'oversized payload rejected');

/* ---------- legal play + idempotency ---------- */
const actsSnap = S.getSnapshot('s1', turnId).publicState;
const acts = actsSnap.legalActions;
ok(acts.length > 0, 'legal actions advertised');
const a0 = acts.find(a => a.type === 'play') || acts[0];
r = S.submitCommand('s1', turnId, 'cmd-1', a0);
ok(r.ok && r.stateHash, 'legal command accepted with state hash');
const dup = S.submitCommand('s1', turnId, 'cmd-1', a0);
ok(dup.ok && dup.duplicate === true, 'duplicate command id is idempotent');

/* ---------- full game to terminal ---------- */
{
  let guard = 0;
  let done = false;
  while (guard++ < 2000 && !done) {
    const cur = S.getSnapshot('s1', 'alice'); // member observer view
    const ps = cur.publicState;
    if (ps.phase === 'match-over') { done = true; break; }
    if (ps.phase === 'round-over') {
      S.submitCommand('s1', ps.players[0].id, 'nr-' + guard, { type: 'next-round' });
      continue;
    }
    const pid = ps.turnPlayerId;
    const v = S.getSnapshot('s1', pid).publicState;
    const acts2 = v.legalActions;
    const r2 = S.submitCommand('s1', pid, 'g' + guard, acts2[0]);
    if (!r2.ok) { ok(false, 'server game command rejected: ' + r2.reason); break; }
  }
  ok(done, 'hosted game reaches terminal state');
  const end = S.endSession('s1');
  ok(end.ok && end.result.terminal && typeof end.result.terminal.winner === 'number', 'result contract returned');
  const rep = S.getReplay('s1');
  ok(rep.ok && rep.replay.commands.length > 0 && rep.replay.finalHash, 'replay available with final hash');
}

/* ---------- timeout forfeit ---------- */
S._reset();
S.createSession({ sessionId: 's2', seed: 't', players: [{ id: 'a' }, { id: 'b' }], turnDeadlineMs: 5000 });
const before = Date.now();
const ev = S.tick('s2', before + 6000);
ok(ev && ev.ended && ev.ended.reason === 'timeout', 'deadline lapse forfeits the match');
ok(ev.ended.terminal.winner === 0 || ev.ended.terminal.winner === 1, 'forfeit winner set');

/* ---------- reconnect ---------- */
S._reset();
S.createSession({ sessionId: 's3', seed: 'r', players: [{ id: 'a' }, { id: 'b' }] });
const s3a = S.getSnapshot('s3', 'a').publicState;
const p3 = s3a.turnPlayerId;
const mv = S.getSnapshot('s3', p3).publicState.legalActions[0];
S.submitCommand('s3', p3, 'x1', mv);
S.markConnected('s3', 'a', false);
ok(!S.submitCommand('s3', 'a', 'x2', { type: 'pass' }).ok, 'disconnected player cannot act');
S.markConnected('s3', 'a', true);
const re = S.getSnapshot('s3', 'a');
ok(re.ok && re.publicState.tick === 1, 'reconnect snapshot reflects authoritative tick');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
