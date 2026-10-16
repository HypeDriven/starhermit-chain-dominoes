// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders and markup survive, and the language follows
// sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/ui.js', 'js/session.js', 'js/main.js', 'js/platform.js', 'js/content.js']) codeKeys(read(f), ['tr'], ['N']).forEach((k) => keys.add(k));
  for (const m of read('js/audio.js').matchAll(/_caption\((?:\w+ \? )?'((?:[^'\\]|\\.)*)'(?: : '((?:[^'\\]|\\.)*)')?\)/g)) { keys.add(m[1]); if (m[2]) keys.add(m[2]); }
  const C = require('../js/content.js');
  for (const t of C.TUTORIALS) { keys.add(t.title); keys.add(t.intro); keys.add(t.outro); for (const s of t.steps) keys.add(s.text); }
  for (const s of C.JOURNEY) { keys.add(s.name); if (s.blurb) keys.add(s.blurb); }
  for (const c of C.CHALLENGES) { keys.add(c.name); keys.add(c.goal); }
  for (const t of C.THEMES) keys.add(t.name);
  const P = require('../js/platform.js');
  for (const a of P.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  // Seat names and leaderboard mode labels are translated where shown.
  // Daily goal variants (C.dailyGoalText).
  ["Today's shared table: first to {n}.", "Today's shared table: first to {n}, boneyard closed.", "Today's shared table: first to {n}, one draw per turn."].forEach((k) => keys.add(k));
  ['You', 'Guide', 'Player 1', 'Player 2', 'daily', 'journey', 'challenge', 'practice', 'tutorial'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CDM_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CDMI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color-vision palette'), 'Colour-vision palette');
});
