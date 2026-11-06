// Localization coverage: every English key the engine client (native/*.ts),
// the session, the content and progress show is translated in every locale
// (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders and
// markup survive, and no table keeps a key nothing shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { codeKeys, audit } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read('native/' + f);
    codeKeys(src, ['tr', 'pn']).forEach((k) => keys.add(k));
    for (const m of src.matchAll(/caption\(\s*(?:\w+ \? )?"((?:[^"\\]|\\.)*)"(?: : "((?:[^"\\]|\\.)*)")?\)/g)) { keys.add(m[1]); if (m[2]) keys.add(m[2]); }
  }
  codeKeys(read('js/session.js'), ['tr']).forEach((k) => keys.add(k));
  const C = require('../js/content.js');
  for (const t of C.TUTORIALS) { keys.add(t.title); keys.add(t.intro); keys.add(t.outro); for (const s of t.steps) keys.add(s.text); }
  for (const s of C.JOURNEY) { keys.add(s.name); if (s.blurb) keys.add(s.blurb); }
  for (const c of C.CHALLENGES) { keys.add(c.name); keys.add(c.goal); }
  for (const t of C.THEMES) keys.add(t.name);
  const P = require('../js/progress.js');
  for (const a of P.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  // Daily goal and name variants (C.dailyGoalText / dailyNameText).
  ["Today's shared table: first to {n}.", "Today's shared table: first to {n}, boneyard closed.", "Today's shared table: first to {n}, one draw per turn.", 'Daily Table — {date}'].forEach((k) => keys.add(k));
  // Seat names, AI levels, leaderboard mode labels and the practice table's name are translated where shown.
  ['You', 'Guide', 'Player 1', 'Player 2', 'easy', 'medium', 'hard', 'daily', 'journey', 'challenge', 'practice', 'tutorial', 'Practice'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && !k.startsWith('starhermit.')).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});
