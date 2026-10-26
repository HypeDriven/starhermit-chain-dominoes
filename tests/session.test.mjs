// session.test.mjs — js/session.js as the engine client drives it: the AI's
// turns on the client's timers (runtime fixed steps), the match clock
// advanced by the client (advanceClock), pause holding both, a journey
// match played to its results with progress, achievements and the local board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/rules.js');
const C = require('../js/content.js');
const { Session } = require('../js/session.js');
const P = require('../js/progress.js');

function harness() {
  const queue = [];
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; queue.push({ id, ms, fn }); return id; },
    clearTimeout(id) { const i = queue.findIndex((t) => t.id === id); if (i >= 0) queue.splice(i, 1); },
  };
  let saves = 0;
  const doc = P.normalize({});
  const store = { doc, progress: doc.progress, profile: doc.profile, settings: { timingAssist: false, reducedMotion: false }, saveNow() { saves++; }, now: () => 1 };
  const events = [];
  const s = new Session({ store, audio: null, timers, externalClock: true });
  s.onEvent = (name, payload) => events.push({ name, payload });
  const run = () => { while (queue.length) queue.shift().fn(); };
  return { s, queue, run, events, store, saves: () => saves };
}

test('AI turns wait on the client timers; pause drops them, resume brings them back', () => {
  const h = harness();
  const ch = C.CHALLENGES[0];
  h.s.startMatch('challenge', ch, C.challengeToConfig(ch, 'Guest'), { undo: false, hints: false, ranked: true, timeLimitSec: 0 });
  // Play until an AI turn is pending.
  for (let i = 0; i < 50 && !h.queue.length; i++) {
    const acts = R.legalActions(h.s.state, h.s.state.turn);
    h.s.act(acts.find((a) => a.type === 'play') || acts[0], 'x' + i);
  }
  assert.ok(h.queue.length >= 1, 'an AI turn is scheduled');
  assert.ok(h.queue[0].ms >= 550 && h.queue[0].ms <= 1150, 'the browser build\'s thinking delay');
  h.s.pause();
  assert.equal(h.queue.length, 0);
  h.s.resume();
  assert.equal(h.queue.length, 1);
  const turn = h.s.state.turn;
  h.run();
  assert.notEqual(h.s.state.turn, turn);
});

test('the match clock is the client\'s: a speed challenge ends when its time runs out', () => {
  const h = harness();
  const ch = C.CHALLENGES.find((c) => c.timeLimitSec);
  h.s.startMatch('challenge', ch, C.challengeToConfig(ch, 'Guest'), { undo: false, hints: false, ranked: true, timeLimitSec: ch.timeLimitSec });
  h.s.advanceClock(1000);
  assert.equal(h.events.at(-1).name, 'clock');
  assert.equal(h.events.at(-1).payload.remainingMs, ch.timeLimitSec * 1000 - 1000);
  h.s.pause();
  h.s.advanceClock(1e9);
  assert.equal(h.s.state.phase, 'active', 'no time passes while paused');
  h.s.resume();
  h.s.advanceClock(ch.timeLimitSec * 1000);
  assert.equal(h.s.state.phase, 'match-over');
  const res = h.events.find((e) => e.name === 'results');
  assert.equal(res.payload.terminal.reason, 'time-expired');
});

test('a journey match to its results: stars, stats, achievements, the local board', () => {
  const h = harness();
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  try {
    const stage = C.JOURNEY[0];
    h.s.startMatch('journey', stage, C.stageToConfig(stage, 'Guest'), { undo: true, hints: true, ranked: false, timeLimitSec: 0 });
    for (let i = 0; i < 2000 && h.s.state.phase !== 'match-over'; i++) {
      h.run();
      const st = h.s.state;
      if (st.phase === 'round-over') { h.s.continueNextRound(); continue; }
      if (st.phase !== 'active' || st.players[st.turn].kind !== 'human') continue;
      const acts = R.legalActions(st, st.turn);
      h.s.act(acts.find((a) => a.type === 'play') || acts[0], 'm' + i);
    }
    const res = h.events.find((e) => e.name === 'results').payload;
    assert.equal(res.won, true);
    assert.ok(res.stars >= 1);
    assert.equal(h.store.progress.journey[stage.id].stars, res.stars);
    assert.equal(h.store.progress.stats.matches, 1);
    assert.ok(h.store.progress.achievements.first_win);
    assert.equal(P.localBoard().length, 1);
    assert.ok(h.saves() > 0);
  } finally { delete globalThis.localStorage; }
});
