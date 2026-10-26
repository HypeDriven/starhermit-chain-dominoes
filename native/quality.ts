// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the coffee steam scaled within the tier by the level (frame().levelIndex),
// as the browser build scaled it by its hardware level. The runtime owns the
// rest of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout, and the shadow-map size and MSAA samples it holds to the
// level. The per-category overrides of the old panel are not offered (the
// runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Table, felt, wall, cup and tiles: Lambert, standard PBR, or physical (clearcoat glaze when detailed). */
  material: "lambert" | "standard" | "physical";
  /** Tile-face canvas width in px (the face is twice as tall). */
  faceTexture: number;
  /** Rounded-corner curve and bevel segments of every tile. */
  tileCurve: number;
  tileBevel: number;
  /** Bloom and AO resolution as a fraction of the frame. */
  bloomRes: number;
  aoRes: number;
  /** Coffee-steam points. */
  steam: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** RoomEnvironment reflections on the glaze, cup and wood. */
  reflections: boolean;
  /** Clearcoat glaze, normal-mapped felt, wood and pips, 2× face textures. */
  detailed: boolean;
  /** Window-light shimmer. */
  ambience: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, detailed: false, ambience: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, ambience: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, ambience: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, ambience: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", faceTexture: 128, tileCurve: 3, tileBevel: 1, bloomRes: 0.5, aoRes: 0.5, steam: 16 },
  balanced: { material: "standard", faceTexture: 256, tileCurve: 6, tileBevel: 2, bloomRes: 0.5, aoRes: 0.5, steam: 24 },
  high: { material: "physical", faceTexture: 256, tileCurve: 8, tileBevel: 3, bloomRes: 0.5, aoRes: 0.5, steam: 120 },
  ultra: { material: "physical", faceTexture: 512, tileCurve: 12, tileBevel: 4, bloomRes: 1, aoRes: 1, steam: 200 },
};
/** The browser build's Particles cap: low tiers 24 points, high tiers 480. */
const STEAM_CAP: Record<Preset, number> = { low: 24, balanced: 24, high: 480, ultra: 480 };
export const MAX_STEAM = 480;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: the steam grows with the
  // level above the tier's first, at most four times the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.steam = Math.min(STEAM_CAP[preset], Math.round(b.steam * k));
  return { preset, ...TABLE[preset], budget: b };
}
