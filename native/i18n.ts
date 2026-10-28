// Localization: the browser build's string tables (locales/*.js through
// i18n.js: the nine StarHermit locales, US-English text as the key) and the
// account strings (sh-strings.js), in the interface language the runtime
// reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's Language setting (sh-language.js) and
// the DOM re-labelling: every string is drawn through T() each frame, so a
// change shows on the next frame without touching the round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, ShStrings, type AccountStrings, type Vehicle } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (sh-language.js: es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US").replace("_", "-");
  const exact = I18n.LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  I18n.setLocale(next);
  locale = I18n.lang();
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account strings (signIn, invite, copied, copyFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: keyof AccountStrings, vars?: Vars): string {
  let s = (ShStrings[locale] ?? ShStrings["en-US"]!)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

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
