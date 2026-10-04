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
    await host.syncTime();
    assert.equal(host.inviteLink(), null);
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});
