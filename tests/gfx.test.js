/* Chain Dominoes — graphics quality model unit tests (node --test, or plain node). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/gfx.js');

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(G.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(G.detectPreset('Apple M2'), 'high');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(G.detectPreset('Adreno (TM) 640'), 'balanced');
  assert.equal(G.detectPreset(''), 'balanced');
});

test('mobile caps Auto at balanced', () => {
  assert.equal(G.detectPreset('Apple M1', true), 'balanced');
  assert.equal(G.detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses detected preset, explicit preset wins', () => {
  const a = G.resolve({}, 'low');
  assert.equal(a.preset, 'low'); assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off'); assert.equal(a.post, false); assert.equal(a.cap, 1);
  const h = G.resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high'); assert.equal(h.auto, false);
  assert.equal(h.shadows, 'medium'); assert.equal(h.ao, 'on'); assert.equal(h.post, true);
  assert.equal(h.shadowMap, 2048);
});

test('resolve: legacy "medium" quality maps to balanced', () => {
  assert.equal(G.resolve({ preset: 'medium' }, 'low').preset, 'balanced');
});

test('resolve: overrides apply, invalid tiers fall back to the preset', () => {
  const r = G.resolve({ preset: 'low', bloom: 'on', shadows: 'bogus', particles: 'high' }, 'low');
  assert.equal(r.bloom, 'on'); assert.equal(r.shadows, 'off'); assert.equal(r.particles, 'high');
  assert.equal(r.post, true);
});

test('resolve: render scale clamps to 50-200%', () => {
  assert.equal(G.resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(G.resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(G.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(G.resolve({}).adaptive, true);
  assert.equal(G.resolve({ adaptive: false, show_fps: true }).showFps, true);
});

test('choosePreset clears overrides and keeps other settings', () => {
  const s = G.choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true }, 'ultra');
  assert.equal(s.preset, 'ultra'); assert.equal(s.bloom, undefined); assert.equal(s.ao, undefined);
  assert.equal(s.render_scale, 1.5); assert.equal(s.show_fps, true);
  assert.equal(G.resolve(s).ao, 'high');
});

test('presetTier and describe', () => {
  assert.equal(G.presetTier('balanced', 'antialias'), 'fxaa');
  assert.equal(G.presetTier('medium', 'shadows'), 'low');
  const d = G.describe(G.resolve({ preset: 'high' }), [800, 600]);
  assert.match(d, /2048² shadows/); assert.match(d, /SMAA/); assert.match(d, /800×600 px/);
  assert.match(G.describe(G.resolve({ preset: 'low' })), /no shadows/);
});

test('every locale has every string', () => {
  const keys = Object.keys(G.STRINGS['en-US']);
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    for (const k of keys) assert.ok(G.STRINGS[loc] && G.STRINGS[loc][k], `${loc}.${k}`);
  }
  assert.equal(G.pickLocale('es-MX'), 'es-419');
  assert.equal(G.pickLocale('es-ES'), 'es-ES');
  assert.equal(G.pickLocale('fr-CA'), 'fr-CA');
  assert.equal(G.pickLocale('de-AT'), 'de-DE');
  assert.equal(G.pickLocale('ja-JP'), 'en-US');
});
