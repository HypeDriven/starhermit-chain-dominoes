// progress.test.mjs — js/progress.js: the engine save document, two devices'
// saves merged, the browser build's cloud save (the JS SDK's save.json: the
// checksummed { checksum, payload } of its whole document) and settings
// migrated, achievements unlocked once, the device's local board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/progress.js');

test('save conflict merge keeps the better of both devices', () => {
  const local = { journey: { j1: { stars: 3, bestScore: 40 } }, tutorials: ['t1'], achievements: { first_win: 500 },
    stats: { matches: 4, wins: 2 }, daily: { '2026-01-01': { score: 20, won: false } }, masteryXP: 3 };
  const remote = { journey: { j1: { stars: 1, bestScore: 90 }, j2: { stars: 2, bestScore: 10 } }, tutorials: ['t2'],
    achievements: { first_win: 100, streak_5: 300 }, stats: { matches: 9, wins: 1 },
    daily: { '2026-01-01': { score: 35, won: true } }, masteryXP: 1 };
  const m = P.mergeProgress(JSON.parse(JSON.stringify(local)), remote);
  assert.deepEqual(m.journey.j1, { stars: 3, bestScore: 90 });
  assert.deepEqual(m.journey.j2, { stars: 2, bestScore: 10 });
  assert.deepEqual(m.tutorials.sort(), ['t1', 't2']);
  assert.deepEqual(m.achievements, { first_win: 100, streak_5: 300 });
  assert.deepEqual(m.stats, { matches: 9, wins: 2 });
  assert.deepEqual(m.daily['2026-01-01'], { score: 35, won: true });
  assert.equal(m.masteryXP, 3);
});

test('engine save documents merge; each device keeps its resumable match and name', () => {
  const sm = { mode: 'journey', content: null, config: { seed: 'x' }, stateJson: '{}', elapsedMs: 5 };
  const local = P.normalize({ v: 1, profile: { name: 'Ada' }, progress: { tutorials: ['t1'] }, savedMatch: sm });
  const remote = P.normalize({ v: 1, profile: { name: 'Bo' }, progress: { tutorials: ['t2'], masteryXP: 4 }, savedMatch: { ...sm, mode: 'daily' } });
  const m = P.mergeDocs(remote, local);
  assert.equal(m.v, 1);
  assert.equal(m.profile.name, 'Ada');
  assert.equal(m.savedMatch.mode, 'journey');
  assert.deepEqual(m.progress.tutorials.sort(), ['t1', 't2']);
  assert.equal(m.progress.masteryXP, 4);
  // A device without a match or a name takes the other's.
  const fresh = P.mergeDocs(remote, P.normalize({}));
  assert.equal(fresh.profile.name, 'Bo');
  assert.equal(fresh.savedMatch.mode, 'daily');
  assert.equal(P.docFromSave({ v: 2 }), null);
  assert.deepEqual(P.docFromSave(m), m);
});

test("the browser build's cloud save migrates: progress, the guest's name, the game's own settings", () => {
  const doc = {
    version: 1, profile: { name: 'Cleo', guest: true },
    settings: { theme: 'sage-garden', quality: 'high', volumes: { music: 0.2 }, muted: true, leftHanded: true, showNumbers: true,
      colorVision: 'tritanopia', holdToConfirm: false, timingAssist: true, haptics: false, hints: false, undo: true, bindings: { pause: 'KeyQ' } },
    progress: { journey: { 'journey-1': { stars: 2, bestScore: 33 } }, tutorials: ['t1-matching'], achievements: { first_win: 1 },
      stats: { matches: 3, wins: 1, streak: 1, bestStreak: 1, rounds: 5, dominos: 1 }, daily: {}, masteryXP: 2 },
    savedMatch: null, updatedAt: 99,
  };
  const payload = JSON.stringify(doc);
  const { doc: d, settings } = P.fromBrowserSave(JSON.stringify({ checksum: P.checksum(payload), payload }));
  assert.equal(d.profile.name, 'Cleo');
  assert.deepEqual(d.progress.journey['journey-1'], { stars: 2, bestScore: 33 });
  assert.deepEqual(d.progress.tutorials, ['t1-matching']);
  assert.equal(d.progress.stats.rounds, 5);
  assert.deepEqual(settings, { theme: 'sage-garden', showNumbers: true, colorVision: 'tritanopia', leftHanded: true, holdToConfirm: false, timingAssist: true, haptics: false, hints: false, undo: true });
  // A hosted build's account nickname is not the guest's own name; a corrupt envelope is nothing.
  const hosted = JSON.stringify({ ...doc, profile: { name: 'Account', guest: false } });
  assert.equal(P.fromBrowserSave(JSON.stringify({ checksum: P.checksum(hosted), payload: hosted })).doc.profile.name, 'Guest');
  assert.deepEqual(P.fromBrowserSave(JSON.stringify({ checksum: 'bad', payload })), { doc: null, settings: null });
  assert.deepEqual(P.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(P.fromBrowserSave(null), { doc: null, settings: null });
});

test('settings are checked; legacy keys listed', () => {
  assert.equal(P.checkSetting('theme', 'mono-ink'), 'mono-ink');
  assert.equal(P.checkSetting('theme', 'neon'), undefined);
  assert.equal(P.checkSetting('haptics', 'yes'), undefined);
  assert.equal(P.checkSetting('volumes', {}), undefined);
  for (const k of P.GAME_SETTING_KEYS) assert.ok(P.BROWSER_SETTING_KEYS.includes(k), k);
  for (const k of P.GAME_SETTING_KEYS) assert.notEqual(P.checkSetting(k, P.DEFAULT_SETTINGS[k]), undefined, k);
});

test('achievements unlock once; the local board keeps the best 100', () => {
  let saves = 0;
  const store = { progress: P.normalize({}).progress, saveNow() { saves++; }, now: () => 1234 };
  assert.equal(P.unlock(store, 'first_win').name, 'First Domino');
  assert.equal(store.progress.achievements.first_win, 1234);
  assert.equal(P.unlock(store, 'first_win'), null);
  assert.equal(P.unlock(store, 'nope'), null);
  assert.equal(saves, 1);
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  try {
    for (let i = 0; i < 105; i++) P.localSubmit({ name: 'G', score: i, durationMs: 1000, mode: 'daily' });
    const b = P.localBoard();
    assert.equal(b.length, 100);
    assert.equal(b[0].score, 104);
  } finally { delete globalThis.localStorage; }
});
