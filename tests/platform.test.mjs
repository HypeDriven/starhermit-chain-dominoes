// platform.test.mjs — js/platform.js host adapter on top of starhermit-sdk.js
// with a stubbed fetch and launch fragment: token read, profile nickname,
// cloud save round-trip on game:<slug>, settings KV, bindings, matchmaking,
// and no network at all when standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installHosted, installStandalone, resp, UID } from './starhermit-harness.mjs';

const require = createRequire(import.meta.url);
const SLUG = 'chain-dominoes';
const DEFAULTS = { pause: 'KeyP', undo: 'KeyU', endLeft: 'KeyA' };

test('hosted: token, profile, cloud save, settings, bindings, queues, invite', async () => {
  const { sdk, env } = installHosted(SLUG, {
    extra: (path, method) => {
      if (path === `/api/v1/games/${SLUG}/queues`) return resp(200, [{ key: 'duo' }]);
      if (path === `/api/v1/games/${SLUG}/matchmaking?queues=duo` && method === 'POST') return resp(200, { status: 'queued' });
      if (path === `/api/v1/games/${SLUG}/matchmaking` && method === 'GET') return resp(200, { status: 'matched', sessionId: 'x' });
      return null;
    },
  });
  const { host } = require('../js/platform.js');
  assert.equal(sdk.userId, UID);
  assert.equal(host.init(), true);
  assert.equal(host.scope, SLUG);
  assert.equal((await host.fetchProfile()).name, 'Ada');

  assert.equal(await host.cloudLoadRaw(), null);
  const wrapped = JSON.stringify({ checksum: 'c', payload: '{"version":1}' });
  host.cloudPush(wrapped);
  assert.equal(await host.flushCloudSave(), true);
  const put = env.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/cloud-saves/game%3Achain-dominoes'), put.url);
  assert.equal(await host.cloudLoadRaw(), wrapped);

  assert.deepEqual(await host.getSettings(), {});
  await host.patchSettings({ muted: true });
  assert.equal(env.settings.muted, true);
  host.mirrorSettings({ muted: false, bindings: { x: 1 } });

  await host.loadBindings(DEFAULTS);
  assert.equal(host.actionFor({ code: 'KeyA' }), 'endLeft');
  assert.equal(host.keyLabel('pause'), 'P');

  await host.matchmakingJoin();
  assert.ok(env.calls.some((c) => c.method === 'POST' && c.url.includes('matchmaking?queues=duo')));
  assert.equal((await host.matchmakingPoll()).status, 'matched');
  assert.equal(host.inviteLink(), `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`);
  assert.equal(host.canSignIn(), false);
});

test('standalone: no token, no network', async () => {
  const st = installStandalone();
  try {
    const { host } = require('../js/platform.js');
    assert.equal(host.init(), false);
    assert.equal(await host.cloudLoadRaw(), null);
    host.cloudPush('{}');
    await host.flushCloudSave();
    assert.deepEqual(await host.getSettings(), {});
    host.mirrorSettings({ muted: true });
    await host.loadBindings(DEFAULTS);
    assert.equal(host.actionFor({ code: 'KeyU' }), 'undo');
    assert.deepEqual(await host.fetchLeaderboard(), { entries: [], local: true });
    assert.deepEqual(await host.submitScore(120), { posted: false, rank: null });
    await host.syncTime();
    assert.equal(host.inviteLink(), null);
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});

test('save conflict merge keeps the better of both devices', () => {
  const P = require('../js/platform.js');
  const local = { journey: { j1: { stars: 3, bestScore: 40 } }, tutorials: ['t1'], achievements: { first_win: 500 },
    stats: { matches: 4, wins: 2 }, daily: { '2026-01-01': { score: 20, won: false } }, masteryXP: 3 };
  const remote = { journey: { j1: { stars: 1, bestScore: 90 }, j2: { stars: 2, bestScore: 10 } }, tutorials: ['t2'],
    achievements: { first_win: 100, streak_5: 300 }, stats: { matches: 9, wins: 1 },
    daily: { '2026-01-01': { score: 35, won: true } }, masteryXP: 1 };
  const m = P.mergeProgress(local, remote);
  assert.deepEqual(m.journey.j1, { stars: 3, bestScore: 90 });
  assert.deepEqual(m.journey.j2, { stars: 2, bestScore: 10 });
  assert.deepEqual(m.tutorials.sort(), ['t1', 't2']);
  assert.deepEqual(m.achievements, { first_win: 100, streak_5: 300 });
  assert.deepEqual(m.stats, { matches: 9, wins: 2 });
  assert.deepEqual(m.daily['2026-01-01'], { score: 35, won: true });
  assert.equal(m.masteryXP, 3);
  // Store.mergeRemote parses the other device's checksummed save and keeps local settings.
  const store = new P.Store();
  store.doc.settings.muted = true;
  const payload = JSON.stringify({ version: 1, progress: remote, settings: { muted: false } });
  store.mergeRemote(JSON.stringify({ checksum: P.checksum(payload), payload }));
  assert.equal(store.doc.settings.muted, true, 'this device keeps its settings');
  assert.ok(store.progress.tutorials.includes('t2'), 'the other device\'s lesson is kept');
});
