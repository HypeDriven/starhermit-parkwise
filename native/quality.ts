// The look per graphics level. The engine's effects come from levelSettings() for
// the frame's level: shadows and their map size, ambient occlusion, bloom, the
// grade and anti-aliasing. The game's own art (gfx.js: materials, reflections,
// segments, textures, skyline, dust and confetti budgets) stays keyed by the
// runtime's quality tier (frame().quality), with the dust motes and the confetti
// scaled within the tier by the level's particle budget over the tier's anchor
// level (at most 2×, capped at 360 each). The runtime owns the rest of what the
// old Graphics section did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. The old
// section's per-effect overrides are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Lit-surface shading: Lambert (Low), Standard (Balanced), clear-coated Physical paint and glass (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Rounded-slab corner / bevel segments (detailed vehicles, AC units). */
  curve: number; bevel: number;
  /** Asphalt / concrete texture size in px (Detailed). */
  texture: number;
  /** Distant city blocks (Detailed). */
  skyline: number;
  /** Dust motes (Particles high) and exit confetti (Particles high; low: half). */
  dust: number; confetti: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Scene detail Detailed: rounded vehicles with glass cabins, textured surfaces, props, skyline. */
  detailed: boolean;
  particles: "low" | "high";
  budget: Budget;
}

const ART: Record<QualityTier, Pick<Look, "reflections" | "detailed" | "particles">> = {
  low: { reflections: false, detailed: false, particles: "low" },
  balanced: { reflections: true, detailed: true, particles: "low" },
  high: { reflections: true, detailed: true, particles: "high" },
  ultra: { reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", curve: 2, bevel: 1, texture: 128, skyline: 20, dust: 40, confetti: 40 },
  balanced: { material: "standard", curve: 3, bevel: 2, texture: 256, skyline: 30, dust: 60, confetti: 60 },
  high: { material: "physical", curve: 5, bevel: 3, texture: 256, skyline: 46, dust: 110, confetti: 120 },
  ultra: { material: "physical", curve: 8, bevel: 4, texture: 512, skyline: 64, dust: 180, confetti: 180 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const DUST_MAX = 360, CONFETTI_MAX = 360;

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.texture = Math.min(b.texture, s.maxTextureSize);
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  b.confetti = Math.min(CONFETTI_MAX, Math.round(b.confetti * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
