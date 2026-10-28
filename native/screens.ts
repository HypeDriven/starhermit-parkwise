// The browser build's DOM shell (index.html + main.js ui/screens wiring) as
// starhermit:ui, built every frame over the lot: the title page over its dusk
// sky and rooftop skyline (Play, Daily challenge, Journey, Settings, How to
// play, sign-in / invite, the profile line), the mode list and the setup
// lists (lessons, the 40 stages with stars and locks, the Daily, Practice
// difficulties, challenges, Score chase seeds), and the play screen — the
// status bar (mode, moves / par, time, the challenge's limit chip, Pause),
// the Objective / Progress / Vehicles rail (the vehicles as buttons: the
// screen-reader board model), the Actions / Session rail, the tray (Undo,
// Hint, Restart; mirrored for the left-handed tray), the sound caption and
// the toast — with the pause, results, settings and help overlays. The old
// media queries are layouts picked by the window's logical size: wide
// (≥ 1024 px: both rails beside the lot) and compact (the rails become
// drawers behind ☰ and ⚙, a scrim closes them; portrait phones share the
// tray between its three buttons). The lot is framed in the playfield
// rectangle left between them (main.ts view → render.ts). Every vehicle and
// every legal-target marker on the lot is a named target (ui.target), as the
// screen-reader board model was, so screen readers and play scripts find them.
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content } from "./classic.ts";
import { N, S, T, formatTime, kindLabel, modeLabel, vehicleName } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  MODES, account, app, closeTop, fresh, hudRects, later, leaderboardLine, leaveRound, nextRound, objectiveText,
  openOverlay, openSetup, pauseGame, personalBest, playing, requestHint, restartRound, resumeGame, selectVehicle, setPage, startChallenge,
  startDaily, startJourney, startLearn, startPractice, startScore, toModes, toTitle, toggleDrawer, top, undoMove, view, type Overlay,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, phone: lw <= 700 && lh > lw, short: lh <= 500 && lw > lh };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean }
const PAD: Record<string, number> = { btn: 52, "btn-primary": 72, "btn-ghost": 56, "btn-good": 52, "btn-tray": 20, "btn-tray-ghost": 24, "vehicle-btn": 26 };
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `name` differing from the text is its accessible name. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected) opts.selected = true;
  const s: ui.Style = width != null ? { width } : {};
  if (b.name && b.name !== b.text) {
    opts.content = () => { ui.style({ text: { weight: "600" } }).label(b.text); };
  } else if (width != null && buttonWidth(b.text, style) > width) {
    // the face's padding and border (.btn 24 px a side, the tray's 8, .vehicle-btn 10 + its 2 px ring)
    const pad = PAD[style] ?? 52;
    const inner = Math.max(20, width - pad);
    const plain = style === "vehicle-btn";
    opts.content = () => { ui.style({ text: plain ? { align: "start", size: 13.6 } : { align: "center", weight: "700" } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons at their own widths in centred rows that wrap at `width` (.btn-row: flex-wrap, gap 12). */
function flow(label: string, list: Btn[], width: number, gap = 12, justify: "start" | "center" | "end" = "center"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A box over a window rectangle (window px) in a class, drawn as a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, cls: string): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, cls) });
  });
}
/** The effective keys of an action, e.g. "U" or "←" (main.js keyLabel over the player's bindings). */
export function keysFor(action: string): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
/** "Undo (U)" with the player's key: the old label's text before its "(…)". */
function withKey(key: string, action: string): string { return `${T(key).replace(/\s*\([^)]*\)\s*$/, "")} (${keysFor(action)})`; }

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  if (app.page === "game") playScreen(L);
  else page(L);
  overlay(L);
  if (app.focusNext) {
    const age = frame().frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ title, modes, setup (the old .screen sections)
/** The title's rooftop skyline (index.html #screen-title::before, an SVG path of steps): the path's tops, x → height of 100. */
const SKYLINE: [number, number, number][] = (() => {
  const d = "M0 100V62h14V48h10v14h8V30h18v32h6V54h12V40h8v-8h6v8h6v22h10V44h16v18h6V24h4v-6h2v6h4v38h8V50h14v12h10V36h20v26h6V46h12v16h8V28h6v-8h4v8h6v34h10V52h12v10h8V40h18v22h6V56h10v6h8V34h14v28h8V46h12v16h6V30h16v32h10V50h12v12h6V58H400v42z";
  const out: [number, number, number][] = [];
  let x = 0, y = 100;
  for (const m of d.matchAll(/([MVHhvz])([-\d.]*)/g)) {
    const c = m[1]!, n = Number(m[2]);
    if (c === "V") y = n;
    else if (c === "v") y += n;
    else if (c === "h" || c === "H") { const nx = c === "h" ? x + n : n; out.push([x, nx, y]); x = nx; }
  }
  return out;
})();
function skyline(): void {
  const f = frame(), sc = ui.preferences().scale;
  const h = Math.min(0.34 * f.height, 260 * sc), y0 = f.height - h;
  paint("title-glow", -0.2 * f.width, 1.08 * f.height - 0.45 * f.height, 1.4 * f.width, 0.9 * f.height, "title-glow");
  ui.place("skyline", { anchor: "top-start", x: -f.safeArea.left / sc, y: (y0 - f.safeArea.top) / sc }, () => {
    ui.widget("", {
      role: "none", size: { width: f.width / sc, height: h / sc }, draw: (r) => {
        for (const seg of SKYLINE) {
          const x = r.x + (seg[0] / 400) * r.width, w = ((seg[1] - seg[0]) / 400) * r.width + 1;
          const top = r.y + (seg[2] / 100) * r.height;
          draw.box(x, top, w, r.y + r.height - top, "skyline");
        }
      },
    });
  });
}
function page(L: Layout): void {
  const f = frame();
  paint("page-bg", 0, 0, f.width, f.height, app.page === "title" ? "title-bg" : "page");
  if (app.page === "title") skyline();
  const w = Math.min(L.lw * 0.94, 640);
  const key = `page-${app.page}-${app.setupMode}`;
  const h = lastSize.get(key) ?? 0;
  const avail = L.lh - 26;
  const scroll = h > avail;
  const opening = f.frame - app.openedFrame <= 5;
  ui.place("page", { anchor: scroll ? "top" : "center", y: scroll ? 12 : 0 }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => {
        if (app.page === "title") titlePage(w);
        else if (app.page === "modes") modesPage(w);
        else setupPage(w);
        if (app.preparing) para(T("Preparing the lot…"), w, "tagline", "preparing");
      }, { width: w, spacing: 14, align: "center" });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: w + 16, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // Back / Escape on the mode and setup pages.
  if (!app.overlays.length && ui.back() && fresh()) {
    if (app.page === "modes") later(toTitle);
    else if (app.page === "setup") later(toModes);
  }
}
function titlePage(w: number): void {
  const p = platform.progress();
  ui.style("brand").id("title-h").label("Parkwise");
  para(T("A rooftop parking puzzle. Slide vehicles along the way they face and open a path so the red car can reach the exit gate."), Math.min(w, 620), "tagline", "tagline");
  button({ id: "btn-play", text: T("Play"), style: "btn-primary", act: () => setPage("modes") });
  flow("title-row1", [
    { id: "btn-daily", text: T("Daily challenge"), act: startDaily },
    { id: "btn-journey-resume", text: T("Journey"), act: () => startJourney(p.journeyUnlocked) },
  ], w);
  flow("title-row2", [
    { id: "btn-settings", text: T("Settings"), style: "btn-ghost", act: () => openOverlay("settings", "btn-settings-close") },
    { id: "btn-help", text: T("How to play"), style: "btn-ghost", act: () => openOverlay("help", "btn-help-close") },
  ], w);
  const acct: Btn[] = [];
  if (!platform.signedIn()) acct.push({ id: "btn-sh-signin", text: S("signIn"), style: "btn-ghost", act: account.signIn });
  if (platform.inviteLink()) acct.push({ id: "btn-sh-invite", text: S("invite"), style: "btn-ghost", act: account.invite });
  if (acct.length) flow("title-row3", acct, w);
  para(profileLine(), w, "tagline", "profile-line");
}
/** main.js renderProfileLine. */
function profileLine(): string {
  if (!platform.signedIn()) return T("Local profile — progress is saved on this device.");
  const sync = platform.syncState();
  const text = T(sync === "saving" ? N("saving to your account…") : sync === "synced" ? N("progress synced to your account") : sync === "offline" ? N("offline — changes stay on this device") : N("progress follows this account"));
  return `${platform.displayName() || T("Player")} — ${text}`;
}
/** A .menu-item: title (and description) at the start, meta at the end; the button's name is the title. */
function menuItem(id: string, w: number, title: string, desc: string | null, meta: string, act: () => void, disabled = false): void {
  const metaW = Math.min(w * 0.35, textWidth(meta, "menu-meta") + 4);
  const tw = w - 40 - metaW - 12;
  const opts: ui.ButtonOptions = {
    content: () => ui.row(`${id}-face`, () => {
      ui.column(`${id}-t`, () => { para(title, tw, "menu-title"); if (desc) para(desc, tw, "menu-desc"); }, { width: tw, spacing: 2 });
      ui.column(`${id}-m`, () => para(meta, metaW, "menu-meta"), { width: metaW, align: "end" });
    }, { spacing: 12, align: "center", width: w - 40 }),
  };
  if (disabled) opts.disabled = true;
  if (ui.style("menu-item", { width: w }).id(id).button(title, opts) && fresh() && !disabled) later(act);
}
function modesPage(w: number): void {
  const p = platform.progress();
  heading("screen-h2", T("Choose a mode"), w, "modes-h");
  ui.column("mode-list", () => {
    for (const m of MODES) {
      let meta = m.ranked ? T("Ranked") : T("Unranked");
      if (m.id === "journey") meta = T("Stage {n} of {total}", { n: p.journeyUnlocked + 1, total: Content.JOURNEY_COUNT });
      if (m.id === "daily") meta = p.lastDaily === platform.todayKey() ? T("Done today") : T("New today");
      menuItem(`mode-${m.id}`, w, T(m.title), T(m.desc, { n: Content.JOURNEY_COUNT }), meta, () => openSetup(m.id));
    }
  }, { width: w, spacing: 10 });
  button({ id: "btn-modes-back", text: T("Back"), style: "btn-ghost", act: toTitle });
}
const SETUP_INFO: Record<string, string> = {
  learn: N("Four short lessons. Expected 2–4 minutes. Unranked, undo allowed."),
  journey: N("Stages get denser and deeper; every tenth is a mastery stage. Ranked, undo and hints allowed with score penalties."),
  daily: N("Same lot for everyone this UTC day. Ranked; score is validated by the server from your replay log."),
  practice: N("Casual generated lots. Restart and undo freely; no rating impact."),
  challenge: N("Constraints apply — watch the HUD limit chip. Ranked."),
  score: N("Fixed seeds, asynchronous global and friends comparison. Ranked."),
};
function setupPage(w: number): void {
  const mode = app.setupMode, p = platform.progress();
  heading("screen-h2", modeLabel(mode), w, "setup-h");
  para(T(SETUP_INFO[mode] ?? ""), w, "tagline", "setup-info");
  ui.column("setup-list", () => {
    const item = (id: string, label: string, meta: string, act: () => void, disabled = false): void => menuItem(id, w, label, null, meta, act, disabled);
    if (mode === "learn") {
      Content.TUTORIALS.forEach((t, i) => item(`learn-${i}`, `${i + 1}. ${T(t.title)}`, p.tutorialsDone.includes(t.id) ? T("completed") : "", () => startLearn(i)));
    } else if (mode === "journey") {
      for (let i = 0; i < Content.JOURNEY_COUNT; i++) {
        const locked = i > p.journeyUnlocked;
        const stars = p.stars[`journey-${i + 1}`] || 0;
        item(`stage-${i + 1}`, T("Stage {n}", { n: i + 1 }) + (Content.difficultyFor(i).mastery ? ` · ${T("Mastery")}` : ""),
          locked ? T("locked") : "★".repeat(stars) || T("new"), () => startJourney(i), locked);
      }
    } else if (mode === "daily") {
      item("daily-today", T("Today’s lot ({date})", { date: platform.todayKey() }), T("one shared lot per UTC day"), startDaily);
    } else if (mode === "practice") {
      item("practice-0", T("Easy"), T("short solutions"), () => startPractice(0));
      item("practice-1", T("Medium"), T("deeper planning"), () => startPractice(1));
      item("practice-2", T("Hard"), T("dense lots"), () => startPractice(2));
    } else if (mode === "challenge") {
      for (let i = 0; i < 6; i++) {
        const e = Content.challengeLevel(i), c = e.challenge!;
        item(`challenge-${i}`, T("Challenge {n} — {kind}", { n: i + 1, kind: kindLabel(c.kind) }),
          c.moveLimit ? T("move limit {n}", { n: c.moveLimit }) : c.timeLimit ? T("{n}s target", { n: c.timeLimit }) : T("no hints"), () => startChallenge(i));
      }
    } else if (mode === "score") {
      for (let i = 0; i < 5; i++) item(`score-${i}`, T("Fixed seed {n}", { n: i + 1 }), T("global board"), () => startScore(i));
    }
  }, { width: w, spacing: 10 });
  button({ id: "btn-setup-back", text: T("Back"), style: "btn-ghost", act: toModes });
}

// ------------------------------------------------------------------ the play screen (index.html #screen-game)
function chips(): { id: string; text: string }[] {
  const s = app.session;
  if (!s) return [];
  const out = [
    { id: "chip-mode", text: modeLabel(s.mode) + (s.entry.challenge ? ` · ${kindLabel(s.entry.challenge.kind)}` : "") },
    { id: "chip-moves", text: T("Moves {n} / par {par}", { n: s.state.moves, par: s.entry.par }) },
    { id: "chip-time", text: formatTime(s.activeSec) },
  ];
  const lim = s.entry.challenge;
  if (lim && lim.moveLimit) out.push({ id: "chip-limit", text: T("Limit {n}", { n: lim.moveLimit }) });
  else if (lim && lim.timeLimit) out.push({ id: "chip-limit", text: T("Left {time}", { time: formatTime(Math.max(0, lim.timeLimit - Math.floor(s.activeSec))) }) });
  return out;
}
function playScreen(L: Layout): void {
  const f = frame(), sc = L.sc, sa = f.safeArea;
  const s = app.session;
  const live = !app.overlays.length && !app.drawer;
  const roundLive = live && playing();
  const small = L.phone || L.short;
  const chipCls = small ? "chip-text-small" : "chip-text";

  // ---- the playfield, from the bars' sizes (as last laid out)
  const barH = lastSize.get("bar") ?? 52;
  const trayH = lastSize.get("tray") ?? 66;
  const railW = L.wide ? Math.min(220, L.lw * 0.2) : 0;
  view.x = sa.left + railW * sc; view.y = sa.top + barH * sc;
  view.width = Math.max(1, (L.lw - 2 * railW) * sc); view.height = Math.max(1, (L.lh - barH - trayH) * sc);
  const W = f.width, H = f.height;
  paint("bg-top", 0, 0, W, view.y, "page");
  paint("bg-bottom", 0, view.y + view.height, W, H - view.y - view.height, "page");
  paint("bg-left", 0, view.y, view.x, view.height, "page");
  paint("bg-right", view.x + view.width, view.y, W - view.x - view.width, view.height, "page");

  // ---- the board's named targets (vehicles and legal-target markers)
  if (s && live) boardTargets();

  // ---- status bar
  const items: { kind: "chip" | "btn"; id: string; text: string; w: number; b?: Btn }[] = [];
  const glyphBtn = (id: string, glyph: string, name: string, act: () => void): void => {
    items.push({ kind: "btn", id, text: glyph, w: buttonWidth(glyph, "btn-ghost"), b: { id, text: glyph, name, style: "btn-ghost", act, disabled: !!app.overlays.length } });
  };
  if (!L.wide) glyphBtn("btn-rail-left", "☰", T("Open objective panel"), () => toggleDrawer("left"));
  for (const c of chips()) items.push({ kind: "chip", id: c.id, text: c.text, w: textWidth(c.text, chipCls) + 26 });
  const pauseText = `II ${T("Pause")}`;
  items.push({ kind: "btn", id: "btn-pause", text: pauseText, w: buttonWidth(pauseText, "btn-ghost"), b: { id: "btn-pause", text: pauseText, name: T("Pause game"), style: "btn-ghost", act: pauseGame, disabled: !roundLive } });
  if (!L.wide) glyphBtn("btn-rail-right", "⚙", T("Open actions panel"), () => toggleDrawer("right"));
  const gap = small ? 8 : 14;
  const rows: (typeof items)[] = [[]];
  let used = 0;
  for (const it of items) {
    if (rows[rows.length - 1]!.length && used + gap + it.w > L.lw - 24) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + it.w;
    rows[rows.length - 1]!.push(it);
  }
  const bar = ui.place("statusbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column("statusbar-col", () => {
      rows.forEach((row, ri) => ui.row(`status-r${ri}`, () => {
        for (const it of row) {
          if (it.kind === "chip") ui.column(it.id, () => ui.style(chipCls).id(`${it.id}-t`).label(it.text), { style: "chip" });
          else button(it.b!);
        }
      }, { spacing: gap, align: "center", justify: "center", width: L.lw - 24 }));
    }, { style: "statusbar", width: L.lw, spacing: 8, padding: { top: small ? 4 : 8, bottom: small ? 4 : 8, start: 12, end: 12 } });
  });
  rect(bar);
  lastSize.set("bar", bar.height / sc);

  // ---- tray
  const undoOff = !roundLive || !s || !s.history.length;
  const hintOff = !roundLive || !s || !!(s.entry.challenge && s.entry.challenge.noHint);
  let trayBtns: Btn[] = [
    { id: "tray-undo", text: T("Undo"), style: "btn-tray", act: undoMove, disabled: undoOff },
    { id: "tray-hint", text: T("Hint"), style: "btn-tray", act: requestHint, disabled: hintOff },
    { id: "tray-restart", text: T("Restart"), style: "btn-tray-ghost", act: restartRound, disabled: !live || !s },
  ];
  if (platform.options.lefty) trayBtns = trayBtns.reverse();
  const tray = ui.place("tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    ui.row("tray-row", () => {
      if (L.phone) { const bw = (L.lw - 24 - 20) / 3; for (const b of trayBtns) button(b, bw); }
      else for (const b of trayBtns) button(b, Math.max(80, buttonWidth(b.text, b.style!)));
    }, { style: "tray", width: L.lw, spacing: 10, justify: "center", padding: { top: L.short ? 6 : 10, bottom: L.short ? 6 : 10, start: 12, end: 12 } });
  });
  rect(tray);
  lastSize.set("tray", tray.height / sc);

  // ---- rails (wide) or drawers (compact)
  if (L.wide) {
    rail("rail-left", "top-start", barH, railW, L.lh - barH - trayH, (w) => leftRail(w, live));
    rail("rail-right", "top-end", barH, railW, L.lh - barH - trayH, (w) => rightRail(w, live));
  } else if (app.drawer) drawer(L, app.drawer);

  // ---- caption and toast
  if (app.caption && !app.overlays.length) {
    ui.place("caption", { anchor: "bottom", y: trayH + 70 }, () =>
      ui.column("caption-col", () => ui.style("caption-text").id("caption-line").label(T(app.caption!.key)), { style: "caption", align: "center" }));
  }
  toastBox(L);
}
function toastBox(L: Layout): void {
  if (!app.toast) return;
  const w = Math.min(L.lw * 0.9, 420);
  ui.place("sh-toast", { anchor: "bottom", y: 16 }, () =>
    ui.column("sh-toast-col", () => para(app.toast!.text(), w - 34, "toast-text", "sh-toast-text"), { style: "toast", align: "center" }));
}

function rail(id: string, anchor: "top-start" | "top-end", topY: number, w: number, h: number, build: (w: number) => void): void {
  const inner = w - 20;
  const scroll = (lastSize.get(id) ?? 0) > h - 20;
  const r = ui.place(id, { anchor, x: 0, y: topY }, () => {
    ui.column(id, () => {
      const body = (): void => {
        const c = ui.column(`${id}-in`, () => build(inner - (scroll ? 14 : 0)), { spacing: 10, width: inner - (scroll ? 14 : 0) });
        lastSize.set(id, c.height / ui.preferences().scale);
      };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: inner, height: h - 20 }, body);
      else body();
    }, { width: w, height: h, spacing: 0, padding: 10 });
  });
  rect(r);
}
function card(id: string, w: number, body: (w: number) => void): void {
  ui.column(id, () => body(w - 28), { style: "rail-card", width: w, spacing: 6 });
}
/** index.html #rail-left: Objective, Progress, and the vehicles (the screen-reader board model). */
function leftRail(w: number, live: boolean): void {
  const s = app.session;
  card("card-objective", w, (iw) => { heading("rail-h3", T("Objective"), iw, "objective-text"); para(objectiveText(), iw, "rail-text", "objective-desc"); });
  card("card-progress", w, (iw) => {
    heading("rail-h3", T("Progress"), iw);
    if (s) para(T("Mode: {mode} · Stage par {par} · Hints used {hints} · Wins {wins}", { mode: modeLabel(s.mode), par: s.entry.par, hints: s.hintsUsed, wins: platform.progress().wins })
      + (s.entry.challenge ? ` · ${T("Constraint: {kind}", { kind: kindLabel(s.entry.challenge.kind) })}` : ""), iw, "rail-text", "progress-desc");
  });
  card("card-vehicles", w, (iw) => {
    heading("rail-h3", T("Vehicles (screen-reader board model)"), iw);
    if (!s) return;
    s.state.vehicles.forEach((v, i) => {
      const label = T("{vehicle} at column {c}, row {r}", { vehicle: vehicleName(v), c: v.x + 1, r: v.y + 1 }) + (v.target ? T(" (target)") : "");
      button({ id: `vehicle-${i}`, text: label, style: "vehicle-btn", selected: i === s.selected, disabled: !live || s.over, act: () => { selectVehicle(i); app.drawer = null; } }, iw);
    });
  });
}
/** index.html #rail-right: the actions with their keys, and the session line. */
function rightRail(w: number, live: boolean): void {
  const s = app.session;
  const on = live && playing();
  card("card-actions", w, (iw) => {
    heading("rail-h3", T("Actions"), iw);
    const list: Btn[] = [
      { id: "btn-undo", text: withKey("Undo (U)", "undo"), act: undoMove, disabled: !on || !s || !s.history.length },
      { id: "btn-hint", text: withKey("Hint (H)", "hint"), act: requestHint, disabled: !on || !s || !!(s.entry.challenge && s.entry.challenge.noHint) },
      { id: "btn-restart", text: withKey("Restart (R)", "restart"), act: restartRound, disabled: !live || !s },
      { id: "btn-camera", text: withKey("Reset camera (C)", "camera"), style: "btn-ghost", act: () => render.resetCamera(), disabled: !live },
    ];
    for (const b of list) button({ ...b, act: () => { b.act(); app.drawer = null; } }, iw);
  });
  card("card-session", w, (iw) => {
    heading("rail-h3", T("Session"), iw);
    if (s) para(T("Seed {seed} · content v{version} · replay log {n} commands", { seed: s.entry.seed.toString(16), version: s.entry.version, n: s.commands.length }), iw, "rail-text", "session-desc");
  });
}
/** Compact: an open rail as a drawer over a scrim; a tap outside closes it. */
function drawer(L: Layout, side: "left" | "right"): void {
  const f = frame(), sc = L.sc;
  const w = Math.min(L.lw * 0.84, 320);
  const sx = side === "left" ? w * sc + f.safeArea.left : 0;
  const scrimW = f.width - w * sc - f.safeArea.left - f.safeArea.right;
  ui.place("drawer-scrim", { anchor: "top-start", x: (sx - f.safeArea.left) / sc - (side === "left" ? 0 : f.safeArea.left / sc), y: -f.safeArea.top / sc }, () => {
    const r = ui.widget(T("Close panel"), { role: "button", size: { width: scrimW / sc + f.safeArea.left / sc, height: f.height / sc }, draw: (q) => draw.box(q.x, q.y, q.width, q.height, "scrim") });
    if (r.activated && fresh()) later(() => { app.drawer = null; });
  });
  const h = L.lh;
  const r = ui.place("drawer", { anchor: side === "left" ? "top-start" : "top-end", x: 0, y: 0 }, () => {
    ui.column("drawer-col", () => {
      const inner = w - 20;
      const key = `drawer-${side}`;
      const scroll = (lastSize.get(key) ?? 0) > h - 20;
      const body = (): void => {
        const c = ui.column(`${key}-in`, () => {
          button({ id: `btn-rail-${side}-close`, text: T("Close panel"), style: "btn-ghost", act: () => { app.drawer = null; } }, inner - (scroll ? 14 : 0));
          if (side === "left") leftRail(inner - (scroll ? 14 : 0), true); else rightRail(inner - (scroll ? 14 : 0), true);
        }, { spacing: 10, width: inner - (scroll ? 14 : 0) });
        lastSize.set(key, c.height / sc);
      };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner, height: h - 20 }, body);
      else body();
    }, { style: "drawer", width: w, height: h + f.safeArea.top / sc + f.safeArea.bottom / sc, spacing: 0 });
  });
  rect(r);
  if (ui.back() && fresh()) later(() => { app.drawer = null; });
}

/** Every vehicle and legal-target marker as a named target over the lot (the old vehicle list's names). */
function boardTargets(): void {
  const s = app.session!;
  s.state.vehicles.forEach((v) => {
    const r = render.vehicleRect(v);
    if (r && r.width > 0) ui.target(T("{vehicle} at column {c}, row {r}", { vehicle: vehicleName(v), c: v.x + 1, r: v.y + 1 }) + (v.target ? T(" (target)") : ""), r, { role: "button" });
  });
  if (s.over) return;
  const v = s.state.vehicles[s.selected];
  if (!v) return;
  for (const mk of render.markersFor(s.selected)) {
    const p = render.screenPos(mk.x, mk.y);
    if (!p) continue;
    const half = 14 * frame().scale;
    const col = Math.round((v.ori === "h" ? mk.x - (v.len - 1) / 2 : mk.x)) + 1, row = Math.round((v.ori === "v" ? mk.y - (v.len - 1) / 2 : mk.y)) + 1;
    ui.target(T("Slide the {vehicle} to column {c}, row {r}", { vehicle: vehicleName(v), c: col, r: row }), { x: p.x - half, y: p.y - half, width: 2 * half, height: 2 * half }, { role: "button" });
  }
}

// ------------------------------------------------------------------ overlays (the old .overlay dialogs)
function overlayTitle(o: Overlay): string {
  if (o === "pause") return T("Paused");
  if (o === "settings") return T("Settings");
  if (o === "help") return T("How to play");
  return app.results?.won ? T("Lot cleared!") : T("Round over");
}
function overlay(L: Layout): void {
  const o = top();
  if (!o) return;
  const f = frame();
  const outer = Math.min(L.lw * 0.94, 560);
  const inner = outer - 44;
  const avail = Math.max(120, L.lh - 32);
  const key = `overlay-${app.overlays.length}-${o}`;
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const opening = f.frame - app.openedFrame <= 6;
  const title = overlayTitle(o);
  const open = ui.dialog(title, "", true, () => {
    const body = (): void => {
      const w = inner - (scroll ? 14 : 0);
      const r = ui.column(`${key}-col`, () => {
        heading("screen-h2", title, w, `${o}-h`);
        if (o === "pause") pauseBody(w);
        else if (o === "results") resultsBody(w);
        else if (o === "settings") settingsBody(w);
        else helpBody(w);
      }, { style: "dialog-box", width: outer - (scroll ? 14 : 0), spacing: 10 });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // Escape closes the overlay (not on the frame it opened: that press opened it); the results have no close.
  if (!open && fresh()) later(() => { if (o === "results") return; closeTop(); });
}
function stack(list: Btn[], w: number): void { for (const b of list) button(b, w); }
function pauseBody(w: number): void {
  stack([
    { id: "btn-resume", text: T("Resume"), style: "btn-primary", act: resumeGame },
    { id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings", "btn-settings-close") },
    { id: "btn-pause-help", text: T("Help"), act: () => openOverlay("help", "btn-help-close") },
    { id: "btn-leave", text: T("Leave round"), style: "btn-ghost", act: leaveRound },
  ], w);
}
function table(id: string, w: number, rows: string[][], numeric: boolean[], shares: number[], head: boolean): void {
  const total = shares.reduce((a, b) => a + b, 0);
  const cw = shares.map((s) => (w * s) / total);
  ui.column(id, () => {
    rows.forEach((cells, ri) => ui.row(`${id}-${ri}`, () => cells.forEach((c, i) => ui.column(`${id}-${ri}-${i}`,
      () => para(c, cw[i]! - 18, head && ri === 0 ? "strong" : numeric[i] ? "score-num" : "text"), { width: cw[i]!, align: numeric[i] ? "end" : "start" })),
      { style: ri === rows.length - 1 ? "score-row-last" : "score-row", width: w, spacing: 0 }));
  }, { width: w, spacing: 0 });
}
function resultsBody(w: number): void {
  const r = app.results, s = app.session;
  if (!r || !s) return;
  para(r.won ? T("Solved in {moves} moves and {time}.", { moves: r.moves, time: formatTime(r.secs) }) : T(r.loseReason || N("The lot stayed jammed.")), w, "headline", "results-headline");
  const rows: [string, number][] = [
    [N("Completion base"), r.sc.base], [N("Move efficiency"), r.sc.parBonus], [N("Time bonus"), r.sc.timeBonus],
    [N("Hint penalty"), r.sc.hintPenalty], [N("Blocked-attempt penalty"), r.sc.invalidPenalty], [N("Challenge bonus"), r.sc.challengeBonus],
  ];
  const c2 = 110;
  ui.column("score-breakdown", () => {
    rows.filter((row) => row[1] !== 0).forEach(([label, v], i) => ui.row(`score-${i}`, () => {
      ui.column(`score-${i}-a`, () => para(T(label), w - c2 - 20, "text"), { width: w - c2 });
      ui.column(`score-${i}-b`, () => para(String(v), c2 - 20, "score-num"), { width: c2, align: "end" });
    }, { style: "score-row", width: w, spacing: 0 }));
    ui.row("score-total", () => {
      ui.column("score-total-a", () => para(T("Total"), w - c2 - 20, "total"), { width: w - c2 });
      ui.column("score-total-b", () => para(String(r.sc.total), c2 - 20, "total-num", "score-total"), { width: c2, align: "end" });
    }, { style: "score-row-last", width: w, spacing: 0 });
  }, { width: w, spacing: 0 });
  const p = platform.progress();
  para(r.won ? T("Career wins: {wins} · Journey stage {n} unlocked", { wins: p.wins, n: p.journeyUnlocked + 1 }) : T("Retry to keep your streak alive."), w, "dim", "results-progress");
  heading("section-h3", T("Leaderboard"), w);
  const lb = leaderboardLine();
  if (lb) para(lb, w, "dim", "results-lb");
  const def = MODES.find((m) => m.id === s.mode);
  if (def && !def.ranked) para(T("{mode} rounds are unranked — no leaderboard entry.", { mode: T(def.title) }), w, "text", "leaderboard-table");
  else if (platform.signedIn() && app.board !== null) {
    if (app.board === undefined) para(T("Loading…"), w, "text", "leaderboard-table");
    else if (!app.board.length) para(T("No entries yet — be the first."), w, "text", "leaderboard-table");
    else table("leaderboard-table", w, [[T("Rank"), T("Name"), T("Score")], ...app.board.map((e) => [String(e.rank), e.name || T("Player"), String(e.score)])], [true, false, true], [1, 4, 2], true);
  } else {
    const best = personalBest();
    para(best != null ? T("Personal best: {score} — global board unavailable for this round.", { score: best }) : T("Leaderboard offline — playing locally."), w, "text", "leaderboard-table");
  }
  const list: Btn[] = [];
  if (r.won) list.push({ id: "btn-next", text: T("Next"), style: "btn-primary", act: nextRound });
  list.push({ id: "btn-retry", text: T("Retry"), act: restartRound });
  list.push({ id: "btn-results-exit", text: T("Exit"), style: "btn-ghost", act: leaveRound });
  flow("results-row", list, w);
}
/** Settings › a row with a label and a check box (index.html .dialog label > input[type=checkbox]); the label wraps. */
function toggle(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  const tw = w - 56;
  ui.row(`${id}-row`, () => {
    ui.column(`${id}-txt`, () => para(T(label), tw, "text"), { width: tw });
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? "#e86a3c" : "#1b2740");
        draw.strokeRoundRect(bx, by, box, box, 4, "#9fb2c8", 1);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#ffffff", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { style: "settings-row", spacing: 12, width: w, align: "center" });
}
function settingsBody(w: number): void {
  const o = platform.options;
  para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), w, "dim", "options-note");
  flow("settings-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
  ], w, 12, "start");
  heading("section-h3", T("Theme"), w);
  const names = [T("Per stage"), ...Content.THEMES.map((t) => T(t.name))];
  const idx = o.theme ? Content.THEMES.findIndex((t) => t.id === o.theme) + 1 : 0;
  const pick = ui.id("opt-theme").select(T("Theme"), idx, names, { width: Math.min(w, 340) } as ui.WidgetOptions);
  if (pick !== idx) later(() => platform.setOption("theme", pick === 0 ? "" : Content.THEMES[pick - 1]!.id));
  heading("section-h3", T("Accessibility"), w);
  toggle("opt-captions", N("Text captions for sounds"), o.captions, w, (v) => platform.setOption("captions", v));
  toggle("opt-hold-drag", N("Hold-to-drag (vs tap-tap)"), o.holdDrag, w, (v) => platform.setOption("holdDrag", v));
  toggle("opt-lefty", N("Left-handed tray"), o.lefty, w, (v) => platform.setOption("lefty", v));
  button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), style: "btn-ghost", act: () => startLearn(0) });
  button({ id: "btn-settings-close", text: T("Done"), style: "btn-primary", act: closeTop });
}
function helpBody(w: number): void {
  heading("section-h3", T("Goal"), w);
  para(T("Slide vehicles along the direction they face until the red car can drive straight out through the glowing exit gate on the right edge of the lot."), w, "dim");
  heading("section-h3", T("Controls"), w);
  const k = keysFor;
  para(`• ${T("Pointer/touch: tap a vehicle to select, then drag along its axis, or tap a glowing target marker.")}`, w, "dim");
  para(`• ${T("Keyboard: {next} picks the next vehicle and the arrow keys slide the selected one; Tab moves through the buttons.", { next: k("next_vehicle") })}`, w, "dim");
  para(`• ${T("{arrows} slide, {undo} undo, {hint} hint, {restart} restart, {camera} reset camera, {pause} pause.", {
    arrows: [k("left"), k("right"), k("up"), k("down")].join(" "), undo: k("undo"), hint: k("hint"), restart: k("restart"), camera: k("camera"), pause: `${k("pause")}/${k("menu")}`,
  })}`, w, "dim", "help-keys");
  para(`• ${T("Gamepad: the left stick or D-pad slides, Y picks the next vehicle, B undoes, X shows a hint, Start pauses.")}`, w, "dim");
  heading("section-h3", T("Scoring"), w);
  para(T("Score combines a completion base, a bonus for beating the move par, a time bonus, and penalties for hints and blocked attempts. Fewer moves and faster solves score higher."), w, "dim");
  button({ id: "btn-help-close", text: T("Close"), style: "btn-primary", act: closeTop });
}
