// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom and their resolutions, the grade,
// anti-aliasing) are the level's own (levelSettings(): the same table every
// StarHermit game reads). The game's art (materials, tile-face texture, tile
// curve and bevel segments, reflections, the window shimmer) is the browser
// build's four presets (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS
// on the weakest GPU Auto gave it) keyed by the level's quality tier, with
// the coffee steam scaled within the tier by the level's particle budget
// against the tier's anchor level (quantum, molecular, terrestrial,
// galactic), at most 4×. The runtime owns what the old Graphics panel did
// besides: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution and the frame-rate limit and readout. The
// per-category overrides of the old panel are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
  /** Coffee-steam points. */
  steam: number;
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "detailed" | "ambience">;
const TABLE: Record<Preset, Art> = {
  low: { reflections: false, detailed: false, ambience: false },
  balanced: { reflections: true, detailed: true, ambience: true },
  high: { reflections: true, detailed: true, ambience: true },
  ultra: { reflections: true, detailed: true, ambience: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", faceTexture: 128, tileCurve: 3, tileBevel: 1, steam: 16 },
  balanced: { material: "standard", faceTexture: 256, tileCurve: 6, tileBevel: 2, steam: 24 },
  high: { material: "physical", faceTexture: 256, tileCurve: 8, tileBevel: 3, steam: 120 },
  ultra: { material: "physical", faceTexture: 512, tileCurve: 12, tileBevel: 4, steam: 200 },
};
/** The browser build's Particles cap: low tiers 24 points, high tiers 480. */
const STEAM_CAP: Record<Preset, number> = { low: 24, balanced: 24, high: 480, ultra: 480 };
export const MAX_STEAM = 480;
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The steam grows with the level's particle budget above the tier's
  // anchor, at most four times the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.steam = Math.min(STEAM_CAP[preset], Math.round(b.steam * k));
  b.faceTexture = Math.min(b.faceTexture, s.maxTextureSize);
  return {
    preset, ...TABLE[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
