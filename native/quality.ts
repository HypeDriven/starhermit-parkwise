// The look per graphics level: the browser build's four presets and budgets
// (gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the dust motes and the confetti scaled within the tier by the level
// (frame().levelIndex, at most 2×, capped at 360 each), as the browser build
// scaled them by its hardware level. The runtime owns the rest of what the
// old Graphics section did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout.
// The old section's per-effect overrides are not offered (the runtime's
// Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number; aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Scene detail Detailed: rounded vehicles with glass cabins, textured surfaces, props, skyline. */
  detailed: boolean;
  particles: "low" | "high";
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low" },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low" },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high" },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", curve: 2, bevel: 1, texture: 128, skyline: 20, dust: 40, confetti: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", curve: 3, bevel: 2, texture: 256, skyline: 30, dust: 60, confetti: 60, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", curve: 5, bevel: 3, texture: 256, skyline: 46, dust: 110, confetti: 120, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", curve: 8, bevel: 4, texture: 512, skyline: 64, dust: 180, confetti: 180, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const DUST_MAX = 360, CONFETTI_MAX = 360;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the level above the tier's first, at most 2× (gfx.js budgetFor).
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  b.confetti = Math.min(CONFETTI_MAX, Math.round(b.confetti * k));
  return { preset, ...TABLE[preset], budget: b };
}
