// Parkwise on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (rules.js) and the content (content.js
// with the precomputed lots of levels.js) are the browser build's, unchanged
// in what they decide; this module is what main.js did around them — the app
// state machine (title → mode select → setup → active ⇄ paused → resolving →
// results), starting every mode (Learn, Journey, Daily, Practice, Challenge,
// Score chase), the session with its validated, idempotent commands, undo,
// the hint (the solver on a worker), the move limit and the speed clock,
// scoring, stars, achievements and the win streak, the results with the
// leaderboard post, selection and slides by taps, drags, keys and pads, the
// sound captions and announcements, and the lifecycle (a hidden window pauses
// the round, as visibilitychange did). Screens are drawn by screens.ts
// (starhermit:ui), the lot by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: a round's clock advances 1/60 s a step
// while it is active (main.js summed wall time between frames), so a paused
// game, a hidden window and slow frames never move it and play scripts
// replay exactly.
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Rules, type Entry, type Move, type Score, type State } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T, kindLabel, modeLabel, vehicleName } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import * as search from "./search.ts";
import { drawScreens } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

export type Page = "title" | "modes" | "setup" | "game";
export type Overlay = "pause" | "results" | "settings" | "help";
export interface Session {
  mode: string; entry: Entry; state: State; history: State[]; commands: { type: "move"; v: number; dir: number; dist: number }[];
  hintsUsed: number; invalidCount: number; undosUsed: number; activeSec: number; over: boolean; won: boolean; selected: number;
  practiceAttempt: number; practiceTier: number; tutorialText: string | null; finalScore: Score | null; lastActionId: string | null;
}
export interface Results { won: boolean; sc: Score; loseReason: string | null; moves: number; secs: number }

export const app = {
  page: "title" as Page,
  /** main.js appState for the round: active ⇄ paused → resolving → results. */
  phase: "none" as "none" | "active" | "paused" | "resolving" | "results",
  setupMode: "",
  /** The open overlays, top last (the old .overlay dialogs). */
  overlays: [] as Overlay[],
  /** Frame the top overlay or page opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  /** Compact layouts: the open drawer (the old #rail-left / #rail-right .open). */
  drawer: null as "left" | "right" | null,
  session: null as Session | null,
  results: null as Results | null,
  lb: null as platform.Posted | "posting" | null,
  /** Signed in: the board's top ten for the results (undefined: loading). */
  board: undefined as platform.Row[] | null | undefined,
  caption: null as { key: string; until: number } | null,
  toast: null as { text: () => string; until: number } | null,
  /** A Daily or Practice lot being generated on the worker. */
  preparing: null as { cancel: () => void } | null,
  hintPending: null as { cancel: () => void } | null,
  resolveAt: 0,
};
const now = (): number => frame().time;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
let lastAnnounce = "";
export function announce(text: string): void {
  const t = text.trim();
  if (!t || t === lastAnnounce) return;
  lastAnnounce = t;
  ui.announce(t.slice(0, 500));
}
export function toast(text: () => string): void { app.toast = { text, until: now() + 3.2 }; announce(text()); }
/** audio.js captions: text cues for meaningful sounds (Settings › Text captions for sounds). */
const CAPTIONS: Partial<Record<audio.Sfx, string>> = {
  select: N("Vehicle selected"), move: N("Vehicle slid"), invalid: N("That move is blocked"), undo: N("Move undone"),
  hint: N("Hint shown"), win: N("Puzzle solved"), lose: N("Round over"), pause: N("Paused"),
};
export function sfx(kind: audio.Sfx): void {
  audio.play(kind);
  const c = CAPTIONS[kind];
  if (c && platform.options.captions) app.caption = { key: c, until: now() + 1.8 };
}

// ------------------------------------------------------------------ pages and overlays
export function top(): Overlay | null { return app.overlays[app.overlays.length - 1] ?? null; }
function opened(focus: string | null = null): void {
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function setPage(p: Page, focus: string | null = null): void {
  app.page = p;
  app.drawer = null;
  opened(focus);
  render.setActive(p === "game");
}
export function openOverlay(o: Overlay, focus: string | null = null): void {
  app.overlays.push(o);
  app.drawer = null;
  opened(focus);
}
/** Closes the top overlay (Escape, Close, Done). */
export function closeTop(): void {
  const o = app.overlays.pop();
  opened(null);
  if (o === "pause" && app.phase === "paused") resumeGame();
}
export function closeAll(): void { app.overlays = []; opened(null); }
export function toTitle(): void { cancelPending(); closeAll(); setPage("title", "btn-play"); }
export function toModes(): void { cancelPending(); setPage("modes"); }
export function openSetup(mode: string): void { app.setupMode = mode; cancelPending(); setPage("setup"); announce(T("{mode} setup", { mode: modeLabel(mode) })); }
function cancelPending(): void { app.preparing?.cancel(); app.preparing = null; }

// ------------------------------------------------------------------ the session (main.js newSession / executeMove / undoMove / requestHint / endRound)
export const MODES = [
  { id: "learn", title: N("Learn"), desc: N("Interactive lessons — one rule at a time. Unranked."), ranked: false },
  { id: "journey", title: N("Journey"), desc: N("{n} authored stages with mastery checks. Progress saved."), ranked: true },
  { id: "daily", title: N("Daily"), desc: N("One shared lot per UTC day. Ranked, validated on the server."), ranked: true },
  { id: "practice", title: N("Practice"), desc: N("Pick a difficulty, unlimited retry and undo. Unranked."), ranked: false },
  { id: "challenge", title: N("Challenge"), desc: N("Move limits, speed targets, restricted tools."), ranked: true },
  { id: "score", title: N("Score chase"), desc: N("Chase the leaderboard on fixed validated seeds."), ranked: true },
];
let cmdCounter = 0;
export const ACHIEVEMENTS: Record<string, string> = {
  first_completion: N("First clear — solve your first lot"),
  mechanic_mastery: N("Mechanic — solve a stage without undo or hints"),
  streak_3: N("Regular — win three rounds in a row"),
  milestone_hard: N("Rooftop veteran — clear a mastery stage"),
  long_term: N("Commuter — 50 career wins"),
};
function boardKey(mode: string, e: Entry): string { return `${mode}:${e.day || e.seed}`; }

function themeId(): string { return platform.options.theme; }
function newSession(mode: string, entry: Entry, carry: Session | null): void {
  const state = Rules.makeState(entry.level);
  app.session = {
    mode, entry, state, history: [], commands: [], hintsUsed: 0, invalidCount: 0, undosUsed: 0, activeSec: 0, over: false, won: false,
    selected: Rules.targetVehicle(state), practiceAttempt: carry && carry.mode === "practice" ? carry.practiceAttempt : 0,
    practiceTier: carry && carry.mode === "practice" ? carry.practiceTier : 0, tutorialText: null, finalScore: null, lastActionId: null,
  };
  cmdCounter = 0;
  app.hintPending?.cancel();
  app.hintPending = null;
  render.setRound(entry, state, themeId());
  render.setSelected(app.session.selected, false);
}
export function objectiveText(): string {
  const s = app.session;
  if (!s) return "";
  const blockers = Rules.exitBlockers(s.state);
  return s.mode === "learn" && s.tutorialText && s.state.moves === 0 ? T(s.tutorialText)
    : blockers.length === 1 ? T("Guide the red car to the glowing exit gate. 1 vehicle blocks the lane.")
    : blockers.length ? T("Guide the red car to the glowing exit gate. {n} vehicles block the lane.", { n: blockers.length })
    : T("The lane is clear — drive the red car out!");
}
export function beginRound(mode: string, entry: Entry, reason: string, carry: Session | null = app.session): void {
  cancelPending();
  newSession(mode, entry, carry);
  closeAll();
  app.phase = "active";
  app.results = null;
  app.lb = null;
  setPage("game");
  audio.setPlaying(true);
  announce(`${reason} ${objectiveText()}`);
}
export function playing(): boolean { return !!app.session && app.phase === "active" && !app.session.over && !app.overlays.length; }

/** All rule mutations pass through here (validated command, idempotent id). */
export function executeMove(vIdx: number, dir: number, dist: number, actionId?: string): boolean {
  const s = app.session;
  if (!s || s.over || app.phase !== "active") return false;
  if (actionId && actionId === s.lastActionId) return false; // double-commit guard
  s.lastActionId = actionId || `c${++cmdCounter}`;
  const reason = Rules.illegalReason(s.state, vIdx, dir, dist);
  if (reason) {
    s.invalidCount++;
    sfx("invalid");
    announce(T("Cannot move: {reason}.", { reason: T(reason) }));
    render.flashInvalid(vIdx);
    return false;
  }
  s.history.push(s.state);
  s.state = Rules.applyMove(s.state, vIdx, dir, dist);
  s.commands.push({ type: "move", v: vIdx, dir, dist });
  app.hintPending?.cancel();
  app.hintPending = null;
  sfx("move");
  render.syncState(s.state, true);
  if (Rules.isWin(s.state)) { endRound(true, null); return true; }
  const lim = s.entry.challenge;
  if (lim && lim.moveLimit && s.state.moves > lim.moveLimit) { endRound(false, N("Move limit reached")); return true; }
  return true;
}
export function undoMove(): boolean {
  const s = app.session;
  if (!s || !s.history.length || s.over) { sfx("invalid"); return false; }
  s.state = s.history.pop()!;
  s.commands.pop();
  s.undosUsed++;
  app.hintPending?.cancel();
  app.hintPending = null;
  sfx("undo");
  render.syncState(s.state, true);
  return true;
}
export function requestHint(): void {
  const s = app.session;
  if (!s || s.over || app.hintPending) return;
  if (s.entry.challenge && s.entry.challenge.noHint) {
    announce(T("Hints are disabled in this challenge."));
    sfx("invalid");
    return;
  }
  const at = s.state;
  let done = false;
  const cancel = search.hint(at, (move) => {
    done = true;
    app.hintPending = null;
    if (app.session !== s || s.state !== at || s.over) return;
    showHint(s, move);
  });
  if (!done) app.hintPending = { cancel };
}
function showHint(s: Session, move: Move | null): void {
  if (!move) { announce(T("No hint available.")); return; }
  s.hintsUsed++;
  const v = s.state.vehicles[move.v]!;
  sfx("hint");
  const way = move.dir > 0 ? (v.ori === "h" ? N("right") : N("down")) : (v.ori === "h" ? N("left") : N("up"));
  announce(T("Hint: try moving the {vehicle} {dir}.", { vehicle: vehicleName(v), dir: T(way) }));
  s.selected = move.v;
  render.setSelected(move.v, false);
}
export function selectVehicle(i: number): void {
  const s = app.session;
  if (!s || s.over || !s.state.vehicles[i]) return;
  s.selected = i;
  sfx("select");
  render.setSelected(i, false);
  announce(T("{vehicle} selected.", { vehicle: vehicleName(s.state.vehicles[i]!) }));
}
/** Keys and pads: slide the selected vehicle one cell along its axis. */
function slideSelected(act: "left" | "right" | "up" | "down"): void {
  const s = app.session!;
  const v = s.state.vehicles[s.selected]!;
  const map: Record<string, number> = v.ori === "h" ? { left: -1, right: 1 } : { up: -1, down: 1 };
  if (map[act] !== undefined) executeMove(s.selected, map[act]!, 1, `k${++cmdCounter}`);
  else { sfx("invalid"); announce(v.ori === "h" ? T("That vehicle only moves left and right.") : T("That vehicle only moves up and down.")); }
}

function unlock(key: string): void {
  const p = platform.progress();
  if (p.achievements[key]) return;
  p.achievements[key] = Date.now();
  announce(T("Achievement unlocked: {name}", { name: T(ACHIEVEMENTS[key]!) }));
  audio.play("win");
  newAchievements.push(key);
}
let newAchievements: string[] = [];
function endRound(won: boolean, loseReason: string | null): void {
  const s = app.session!;
  const p = platform.progress();
  newAchievements = [];
  if (won && s.mode === "learn" && !p.tutorialsDone.includes(s.entry.id)) p.tutorialsDone.push(s.entry.id);
  s.over = true;
  s.won = won;
  app.phase = "resolving";
  announce(won ? T("Solved!") : T("Round over"));
  render.setSelected(s.selected, true);
  const secs = Math.floor(s.activeSec);
  const sc = Rules.score({ par: s.entry.par, moves: s.state.moves, seconds: secs, hints: s.hintsUsed, invalid: s.invalidCount, won, challenge: !!s.entry.challenge });
  s.finalScore = sc;
  if (won) {
    sfx("win");
    const bk = boardKey(s.mode, s.entry);
    if (!p.bestScores[bk] || sc.total > p.bestScores[bk]!) p.bestScores[bk] = sc.total;
    p.wins++;
    p.winStreak++;
    if (s.hintsUsed === 0 && s.undosUsed === 0 && s.state.moves <= s.entry.par && s.invalidCount === 0) unlock("mechanic_mastery");
    unlock("first_completion");
    if (p.winStreak >= 3) unlock("streak_3");
    if (p.wins >= 50) unlock("long_term");
    if (s.mode === "journey") {
      const idx = parseInt(s.entry.id.split("-")[1]!, 10) - 1;
      p.journeyUnlocked = Math.max(p.journeyUnlocked, Math.min(Content.JOURNEY_COUNT - 1, idx + 1));
      const ref = Rules.score({ par: s.entry.par, moves: s.entry.par, seconds: 30, hints: 0, invalid: 0, won: true }).total;
      const stars = sc.total >= ref * 0.9 ? 3 : sc.total > 700 ? 2 : 1;
      p.stars[s.entry.id] = Math.max(p.stars[s.entry.id] || 0, stars);
      if (s.entry.mastery) unlock("milestone_hard");
    }
    if (s.mode === "daily" && s.entry.day) { p.dailiesDone[s.entry.day] = sc.total; p.lastDaily = s.entry.day; }
  } else {
    sfx("lose");
    p.winStreak = 0;
  }
  platform.saveProgress();
  app.results = { won, sc, loseReason, moves: s.state.moves, secs };
  app.resolveAt = now() + (preferences().reducedMotion ? 0.2 : 0.9);
}
function showResults(): void {
  const s = app.session!, r = app.results!;
  app.phase = "results";
  audio.setPlaying(false);
  if (r.won) render.celebrate();
  app.lb = null;
  app.board = undefined;
  const ranked = MODES.find((m) => m.id === s.mode)?.ranked ?? false;
  if (r.won && ranked && platform.signedIn()) {
    app.lb = "posting";
    void platform.postScore(r.sc.total).then((res) => { if (app.session === s) { app.lb = res; loadBoard(s); } });
  } else if (ranked && platform.signedIn()) loadBoard(s);
  openOverlay("results", r.won ? "btn-next" : "btn-retry");
  announce(`${r.won ? T("Lot cleared!") : T("Round over")} ${T("Total")} ${r.sc.total}.`);
}
function loadBoard(s: Session): void {
  app.board = undefined;
  void platform.topTen().then((rows) => { if (app.session === s) app.board = rows; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
export function personalBest(): number | null {
  const s = app.session;
  if (!s) return null;
  return platform.progress().bestScores[boardKey(s.mode, s.entry)] ?? null;
}

// ------------------------------------------------------------------ mode starters
export function startLearn(i: number): void {
  const t = Content.TUTORIALS[i]!;
  const entry: Entry = { id: t.id, version: Content.CONTENT_VERSION, seed: 100 + i, level: t.level, par: 2, mechanics: ["slide"], tutorial: true, theme: "day", mastery: false };
  beginRound("learn", entry, `${T("Lesson {n}: {title}.", { n: i + 1, title: T(t.title) })} ${T(t.text)}`);
  app.session!.tutorialText = t.text;
}
export function startJourney(i: number): void { beginRound("journey", Content.journeyLevel(i), T("Journey stage {n}.", { n: i + 1 })); }
export function startChallenge(i: number): void {
  const e = Content.challengeLevel(i);
  beginRound("challenge", e, T("Challenge: {kind}.", { kind: kindLabel(e.challenge!.kind) }));
}
export function startScore(i: number): void { beginRound("score", Content.journeyLevel(5 + i * 7), T("Score chase seed {n}.", { n: i + 1 })); }
/** Practice and Daily lots outside levels.js come from the worker (seconds natively): the setup waits on them. */
export function startPractice(tier: number, attempt = 0): void {
  cancelPending();
  let done = false;
  const cancel = search.lot({ kind: "practice", tier, attempt }, (e) => {
    done = true;
    app.preparing = null;
    if (!e) { toast(() => T("The lot could not be prepared.")); return; }
    beginRound("practice", e, T("Practice round."), { mode: "practice", practiceAttempt: attempt, practiceTier: tier } as Session);
  });
  if (!done) app.preparing = { cancel };
}
export function startDaily(): void {
  cancelPending();
  const day = platform.todayKey();
  let done = false;
  const cancel = search.lot({ kind: "daily", day }, (e) => {
    done = true;
    app.preparing = null;
    if (!e) { toast(() => T("The lot could not be prepared.")); return; }
    beginRound("daily", e, T("Daily challenge for {day}.", { day }));
  });
  if (!done) app.preparing = { cancel };
}
export function restartRound(): void {
  const s = app.session;
  if (!s) return;
  beginRound(s.mode, s.entry, T("Round restarted."), s);
  if (s.mode === "learn") app.session!.tutorialText = s.tutorialText;
}
export function nextRound(): void {
  const s = app.session;
  if (!s) return leaveRound();
  closeAll();
  if (s.mode === "journey") {
    const idx = parseInt(s.entry.id.split("-")[1]!, 10);
    if (idx < Content.JOURNEY_COUNT) startJourney(idx); else leaveRound();
  } else if (s.mode === "learn") {
    const i = Content.TUTORIALS.findIndex((t) => t.id === s.entry.id);
    if (i >= 0 && i + 1 < Content.TUTORIALS.length) startLearn(i + 1); else leaveRound();
  } else if (s.mode === "practice") startPractice(s.practiceTier, s.practiceAttempt + 1);
  else leaveRound();
}
export function leaveRound(): void {
  closeAll();
  audio.setPlaying(false);
  app.session = null;
  app.phase = "none";
  app.hintPending?.cancel();
  app.hintPending = null;
  render.setRound(null, null, themeId());
  setPage("modes");
  announce(T("Choose a mode."));
}

// ------------------------------------------------------------------ pause
export function pauseGame(): void {
  if (app.phase !== "active" || !app.session || app.overlays.length) return;
  app.phase = "paused";
  announce(T("Paused."));
  sfx("pause");
  audio.setPlaying(false);
  openOverlay("pause", "btn-resume");
}
export function resumeGame(): void {
  if (!app.session) { leaveRound(); return; }
  closeAll();
  app.phase = "active";
  announce(T("Resumed."));
  audio.setPlaying(true);
}
export function toggleDrawer(side: "left" | "right"): void { app.drawer = app.drawer === side ? null : side; }

export const account = {
  signIn(): void { void requestSignIn().catch(() => undefined); },
  invite(): void {
    const link = platform.inviteLink();
    if (!link) return;
    try { clipboard.writeText(link); toast(() => S("copied")); } catch { toast(() => S("copyFailed")); }
  },
};

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate((dt) => {
  const s = app.session;
  if (!s || hidden) return;
  if (app.phase === "active" && !s.over && !app.overlays.length) {
    s.activeSec += dt;
    const lim = s.entry.challenge;
    if (lim && lim.timeLimit && Math.floor(s.activeSec) >= lim.timeLimit) endRound(false, N("Time ran out"));
  }
  if (app.phase === "resolving" && now() >= app.resolveAt) showResults();
});

// ------------------------------------------------------------------ keys and pads (main.js keydown and pollGamepad)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "menu" || a === "pause") {
    if (!fresh()) return;
    if (app.overlays.length) { if (a === "menu") return; } // dialogs close on their own Escape
    if (app.drawer && a === "menu") { app.drawer = null; return; }
    if (app.phase === "active") pauseGame();
    else if (app.phase === "paused" && a === "menu") resumeGame();
    return;
  }
  if (!playing()) return;
  if (a === "left" || a === "right" || a === "up" || a === "down") { ui.setFocus(null); slideSelected(a); }
  else if (a === "next_vehicle") { ui.setFocus(null); selectVehicle((app.session!.selected + 1) % app.session!.state.vehicles.length); }
  else if (a === "undo") undoMove();
  else if (a === "hint") requestHint();
  else if (a === "restart") restartRound();
  else if (a === "camera") render.resetCamera();
});

// ------------------------------------------------------------------ taps and drags on the lot (main.js pointer handlers)
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
/** The playfield (window pixels), set by screens.ts. */
export const view: render.ViewRect = { x: 0, y: 0, width: 0, height: 0 };
const inView = (x: number, y: number): boolean => x >= view.x && y >= view.y && x <= view.x + view.width && y <= view.y + view.height;
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let drag: { id: number; v: number; sx: number; sy: number; moved: boolean; from: { x: number; y: number } | null } | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  const kind = e.phase === "start" ? "down" : e.phase === "end" ? "up" : e.phase === "move" ? "move" : "cancel";
  events.push({ kind, x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => { if (drag && drag.id === -1 && now() - lastTouch >= 0.6) events.push({ kind: "move", x, y, id: -1 }); });
let pressSeq = 0;
function pointerInput(): void {
  const sc = frame().scale;
  for (const ev of events.splice(0)) {
    if (ev.kind === "down") {
      drag = null;
      if (!playing() || app.drawer || !inView(ev.x, ev.y) || onHud(ev.x, ev.y)) continue;
      const marker = render.pickMarker(ev.x, ev.y);
      if (marker) { ui.setFocus(null); executeMove(marker.v, marker.dir, marker.dist, `p${ev.id}-${++pressSeq}`); continue; }
      const vi = render.pickVehicle(ev.x, ev.y);
      if (vi >= 0) {
        ui.setFocus(null);
        selectVehicle(vi);
        drag = { id: ev.id, v: vi, sx: ev.x, sy: ev.y, moved: false, from: render.pickCell(ev.x, ev.y) };
      }
      continue;
    }
    if (!drag || drag.id !== ev.id) continue;
    if (ev.kind === "move") { if (Math.hypot(ev.x - drag.sx, ev.y - drag.sy) > 8 * sc) drag.moved = true; continue; }
    const d = drag;
    drag = null;
    if (ev.kind === "cancel" || !d.moved || !platform.options.holdDrag || !playing()) continue; // tap = select only
    const s = app.session!;
    const v = s.state.vehicles[d.v]!;
    const cell = render.pickCell(ev.x, ev.y);
    if (!cell || !d.from) continue;
    // travel is measured from where the vehicle was grabbed, so the grab point never biases the distance
    const cells = Math.round(v.ori === "h" ? cell.x - d.from.x : cell.y - d.from.y);
    if (cells === 0) continue;
    const dir = Math.sign(cells);
    // an over-drag parks against the nearest obstacle instead of failing outright
    const reach = Rules.legalActions(s.state).filter((a) => a.v === d.v && a.dir === dir).reduce((m, a) => Math.max(m, a.dist), 0);
    // reach 0 falls through to executeMove so the blocked move is announced
    executeMove(d.v, dir, Math.max(1, Math.min(Math.abs(cells), reach)), `d${d.id}-${++pressSeq}`);
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  search.warm();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  setPage("title", "btn-play");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => render.setTheme(platform.options.theme));
platform.onProgressMerged(() => { if (app.page === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => toast(() => S("signedOut"))); // keep playing locally
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses the round (the player resumes from the pause overlay).
  if (app.phase === "active" && app.session && !app.overlays.length) pauseGame();
  audio.setPlaying(false);
  platform.flush();
});
onResume(() => { hidden = false; if (app.phase === "active" && !app.overlays.length) audio.setPlaying(true); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyPalette(ui.preferences().highContrast);
  audio.update();
  const t = now();
  if (app.caption && app.caption.until < t) app.caption = null;
  if (app.toast && app.toast.until < t) app.toast = null;
});
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
  const f = frame();
  render.update(frameDt, f.time * 1000, f.width, f.height, view);
});
