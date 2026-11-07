// Localization: the engine's string tables (assets/strings.json: the nine StarHermit locales, US-English text
// as the key; the account strings are the engine's starhermit.* keys) in the interface language the runtime
// reports (the player's choice in Options › Language, else the account's preferred language or the device's).
// Every string is drawn through T() each frame, so a change shows on the next frame without touching the round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { type Vehicle } from "./classic.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars | null): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (vars && vars[k] != null ? String(vars[k]) : m));
/** A game string by its English key in the player's language (unknown strings pass through); `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const s = String(key);
  return strings.has(s) ? strings.t(s, vars ?? undefined) : fill(s, vars);
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
const ACCOUNT = {
  signIn: "signIn", invite: "invite", copied: "inviteCopied", copyFailed: "inviteFailed", signedOut: "signedOut",
  lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted", lbNotPosted: "leaderboardNotPosted",
};
/** The engine's account strings. */
export function S(key: keyof typeof ACCOUNT, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }

/** m:ss (main.js formatTime). */
export function formatTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** main.js vehicleName: "red car", "upright van 3", … */
export function vehicleName(v: Vehicle): string {
  if (v.target) return T("red car");
  const key = v.ori === "h" ? (v.len === 3 ? N("sideways van {id}") : N("sideways car {id}")) : (v.len === 3 ? N("upright van {id}") : N("upright car {id}"));
  return T(key, { id: v.id });
}
export function modeLabel(m: string): string {
  return T(({ learn: N("Learn"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge"), score: N("Score chase") } as Record<string, string>)[m] ?? m);
}
export function kindLabel(k: string): string {
  return T(({ "move-limit": N("move limit"), speed: N("speed"), "no-hint": N("no hints") } as Record<string, string>)[k] ?? k);
}
