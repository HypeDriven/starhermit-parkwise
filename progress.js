/* Parkwise — the progress document and the game's options, pure (a classic
 * script in the engine, CommonJS in the Node tests).
 *
 * Progress: { journeyUnlocked, stars, wins, winStreak, tutorialsDone,
 * achievements, dailiesDone, lastDaily, bestScores } as the browser build
 * kept it (main.js; localStorage parkwise.progress.v1 and the `progress` of
 * its game:<slug> cloud doc). Two copies merge record by record (the browser
 * build's platform.js mergeProgress): the larger unlock, wins, streak, stars,
 * daily results and best scores, the union of finished lessons, the earliest
 * achievement unlock, the later last-Daily date.
 *
 * Options: the game's own settings the runtime's Options do not cover — the
 * board theme ('' follows each stage's theme), sound captions, hold-to-drag
 * and the left-handed tray. The browser build kept them with the volumes,
 * graphics, motion, contrast and text size in `settings` (mirrored to the
 * account's settings KV); those others are the runtime's now.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PARKWISE_PROGRESS = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var THEME_IDS = ['dawn', 'day', 'dusk', 'night', 'contrast'];
  var DEFAULT_OPTIONS = { theme: '', captions: true, holdDrag: true, lefty: false };
  var OPTION_KEYS = ['theme', 'captions', 'holdDrag', 'lefty'];
  /** The browser build's settings-KV keys the runtime's Options replaced (removed after the options are adopted). */
  var BROWSER_KEYS = ['volumes', 'muted', 'theme', 'graphics', 'reducedMotion', 'highContrast', 'largeText', 'captions', 'holdDrag', 'lefty'];

  function emptyProgress() {
    return { journeyUnlocked: 0, stars: {}, wins: 0, winStreak: 0, tutorialsDone: [], achievements: {}, dailiesDone: {}, lastDaily: null, bestScores: {} };
  }
  var isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  var nat = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0; };
  function numMap(m) {
    var out = {};
    if (isObj(m)) Object.keys(m).forEach(function (k) { if (typeof m[k] === 'number' && isFinite(m[k])) out[k] = m[k]; });
    return out;
  }

  /** Any stored value → a well-formed progress document. */
  function normalizeProgress(raw) {
    var p = emptyProgress();
    if (!isObj(raw)) return p;
    p.journeyUnlocked = Math.min(39, nat(raw.journeyUnlocked));
    p.stars = numMap(raw.stars);
    p.wins = nat(raw.wins);
    p.winStreak = nat(raw.winStreak);
    p.tutorialsDone = Array.isArray(raw.tutorialsDone) ? raw.tutorialsDone.filter(function (x) { return typeof x === 'string'; }) : [];
    p.achievements = numMap(raw.achievements);
    p.dailiesDone = numMap(raw.dailiesDone);
    p.lastDaily = typeof raw.lastDaily === 'string' ? raw.lastDaily : null;
    p.bestScores = numMap(raw.bestScores);
    return p;
  }

  /** Progress from two devices: the better record of each, nothing dropped (platform.js mergeProgress). */
  function mergeProgress(remote, local) {
    var a = normalizeProgress(remote), b = normalizeProgress(local);
    var out = emptyProgress();
    out.journeyUnlocked = Math.max(a.journeyUnlocked, b.journeyUnlocked);
    out.wins = Math.max(a.wins, b.wins);
    out.winStreak = Math.max(a.winStreak, b.winStreak);
    var maxMap = function (x, y) {
      var o = Object.assign({}, x);
      Object.keys(y).forEach(function (k) { o[k] = Math.max(o[k] || 0, y[k] || 0); });
      return o;
    };
    out.stars = maxMap(a.stars, b.stars);
    out.dailiesDone = maxMap(a.dailiesDone, b.dailiesDone);
    out.bestScores = maxMap(a.bestScores, b.bestScores);
    out.tutorialsDone = a.tutorialsDone.concat(b.tutorialsDone.filter(function (t) { return a.tutorialsDone.indexOf(t) < 0; })).sort();
    out.achievements = Object.assign({}, a.achievements);
    Object.keys(b.achievements).forEach(function (k) { out.achievements[k] = out.achievements[k] ? Math.min(out.achievements[k], b.achievements[k]) : b.achievements[k]; });
    out.lastDaily = [a.lastDaily, b.lastDaily].filter(Boolean).sort().pop() || null;
    return out;
  }

  /** Same content, key order aside. */
  function same(a, b) {
    var canon = function (v) {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
      return JSON.stringify(v);
    };
    return canon(a) === canon(b);
  }

  /** One option value checked; undefined when it is not one. */
  function pickOption(key, v) {
    if (key === 'theme') return v === '' || v === null ? '' : THEME_IDS.indexOf(v) >= 0 ? v : undefined;
    if (key === 'captions' || key === 'holdDrag' || key === 'lefty') return typeof v === 'boolean' ? v : undefined;
    return undefined;
  }

  /** The browser build's cloud doc ({ savedAt, settings, progress }, JSON text) → { progress, options }; null when unreadable. */
  function readForeign(text) {
    var doc;
    try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!isObj(doc)) return null;
    var options = {};
    if (isObj(doc.settings)) {
      OPTION_KEYS.forEach(function (k) { var v = pickOption(k, doc.settings[k]); if (v !== undefined) options[k] = v; });
    }
    return { progress: isObj(doc.progress) ? normalizeProgress(doc.progress) : null, options: options };
  }

  return {
    THEME_IDS: THEME_IDS, DEFAULT_OPTIONS: DEFAULT_OPTIONS, OPTION_KEYS: OPTION_KEYS, BROWSER_KEYS: BROWSER_KEYS,
    emptyProgress: emptyProgress, normalizeProgress: normalizeProgress, mergeProgress: mergeProgress, same: same,
    pickOption: pickOption, readForeign: readForeign,
  };
});
