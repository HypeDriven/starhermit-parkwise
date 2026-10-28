// The browser build's pure scripts, shared with the Node tests and the
// dev server, evaluated as classic scripts so their globals are this
// module's exports: the rules (rules.js: the 6×6 lot, legal slides, the
// BFS solver, integer scoring, hashes and replays), the precomputed lots
// (levels.js) and the content (content.js: lessons, the 40 Journey stages,
// challenges, the Daily and Practice lots, themes), the progress document
// and the game's options (progress.js), the string tables (locales/*.js
// through i18n.js) and the account strings (sh-strings.js).
import { loadClassic } from "starhermit:script";

for (const f of [
  "rules.js", "levels.js", "content.js", "progress.js",
  "locales/en-GB.js", "locales/es.js", "locales/de.js", "locales/fr.js", "locales/pt.js", "locales/it.js",
  "i18n.js", "sh-strings.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Ori = "h" | "v";
export interface Vehicle { id: number; x: number; y: number; len: number; ori: Ori; target: boolean }
export interface Level { grid?: number; exitRow?: number; vehicles: Vehicle[] }
export interface State { grid: number; exitRow: number; vehicles: Vehicle[]; tick: number; moves: number }
export interface Move { v: number; dir: -1 | 1; dist: number }
export interface Score { base: number; parBonus: number; timeBonus: number; hintPenalty: number; invalidPenalty: number; challengeBonus: number; total: number }
export interface Challenge { kind: "move-limit" | "speed" | "no-hint"; moveLimit: number | null; timeLimit: number | null; noHint: boolean }
export interface Entry {
  id: string; version: number; seed: number; level: Level; par: number; mechanics: string[]; tutorial: boolean; theme: string;
  mastery: boolean; day?: string; challenge?: Challenge;
}
export interface Theme {
  id: string; name: string; sky: number; fog: number; ground: number; slab: number; line: number; parapet: number; key: number; target: number; palette: number[];
}
export interface Tutorial { id: string; title: string; text: string; hintVehicle: number; level: Level }
export interface Progress {
  journeyUnlocked: number; stars: Record<string, number>; wins: number; winStreak: number; tutorialsDone: string[];
  achievements: Record<string, number>; dailiesDone: Record<string, number>; lastDaily: string | null; bestScores: Record<string, number>;
}
export interface Options { theme: string; captions: boolean; holdDrag: boolean; lefty: boolean }

interface RulesApi {
  GRID: number; EXIT_ROW: number;
  rng(seed: number): () => number;
  hash(s: string): string;
  stateHash(s: State): string;
  makeState(level: Level): State;
  cellsOf(v: Vehicle): [number, number][];
  legalActions(s: State): Move[];
  illegalReason(s: State, v: number, dir: number, dist: number): string | null;
  applyMove(s: State, v: number, dir: number, dist: number): State;
  targetVehicle(s: State): number;
  isWin(s: State): boolean;
  exitBlockers(s: State): number[];
  solve(s: State, maxNodes?: number): { depth: number; firstMove: Move | null } | null;
  score(o: { par: number; moves: number; seconds: number; hints: number; invalid: number; won: boolean; challenge?: boolean }): Score;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; TUTORIALS: Tutorial[]; JOURNEY_COUNT: number;
  difficultyFor(i: number): { vehicles: number; minDepth: number; maxDepth: number; mastery: boolean };
  journeyLevel(i: number): Entry;
  dailyLevel(day: string): Entry;
  dailyReady(day: string): boolean;
  practiceLevel(tier: number): (attempt: number) => Entry;
  practiceReady(tier: number, attempt: number): boolean;
  challengeLevel(i: number): Entry;
}
interface ProgressApi {
  THEME_IDS: string[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[];
  emptyProgress(): Progress; normalizeProgress(raw: unknown): Progress; mergeProgress(remote: unknown, local: unknown): Progress;
  same(a: unknown, b: unknown): boolean; pickOption(key: string, v: unknown): Options[keyof Options] | undefined;
  readForeign(text: string | null): { progress: Progress | null; options: Partial<Options> } | null;
}
interface I18nApi {
  LOCALES: string[];
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): void;
  lang(): string;
}
export interface AccountStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string;
  lbPosting: string; lbRank: string; lbPosted: string; lbNotPosted: string;
}

const g = globalThis as unknown as {
  PARKWISE_RULES: RulesApi; PARKWISE_CONTENT: ContentApi; PARKWISE_PROGRESS: ProgressApi; PARKWISE_I18N: I18nApi;
  PARKWISE_SH_STRINGS: Record<string, AccountStrings>;
};
export const Rules = g.PARKWISE_RULES;
export const Content = g.PARKWISE_CONTENT;
export const Prog = g.PARKWISE_PROGRESS;
export const I18n = g.PARKWISE_I18N;
export const ShStrings = g.PARKWISE_SH_STRINGS;
