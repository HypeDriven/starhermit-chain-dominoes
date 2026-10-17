/* Chain Dominoes — graphics quality model unit tests (node --test, or plain node). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.StarHermitGpu = require('../js/gpu-level.js');
const G = require('../js/gfx.js');
const { detectPreset, detectLevel, presetForLevel, BUDGETS, resolve } = G;

const desk = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const phone = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', desk), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', desk), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', desk), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', desk), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectPreset('', desk), 'balanced');
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', phone), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', phone) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', phone), 'balanced');
  assert.equal(detectPreset('Mali-G77', phone), 'low');
  assert.equal(detectPreset('SwiftShader', phone), 'low');
});

test('every preset has an explicit budget that grows from Low to Ultra and scales with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  const keys = ['material', 'faceTexture', 'tileCurve', 'tileBevel', 'steam'];
  for (const p of order) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[order[i]][k] >= BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
  }
  const u17 = resolve({ preset: 'ultra' }, 'ultra', 17).budget;
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, u17, 'a manual Ultra on a weak GPU keeps the Ultra floor budget');
  const l0 = resolve({ preset: 'low' }, 'low', 0).budget, l3 = resolve({ preset: 'low' }, 'low', 3).budget;
  for (const k of keys) if (typeof l0[k] === 'number') assert.ok(l3[k] >= l0[k], `low.${k} scales up with the level`);
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
