/*
 * Parkwise — localization core (window.PARKWISE_I18N; CommonJS for tests).
 *
 * Every player-facing string is authored in US English and looked up by that
 * text: T('Play') → the current locale's translation (en-US is the key
 * itself). Placeholders use {name}. N('…') marks a string for extraction
 * without translating it (translated later with T at display time).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * The tables live in locales/*.js (loaded before this file); es-ES and
 * fr-CA only list their differences from es-419 and fr-FR, en-GB only its
 * spelling changes.
 *
 * The locale comes from sh-language.js (window.StarHermitLanguage): the game's
 * Language setting (`ui.language`), Automatic → the StarHermit account's
 * preferred language → navigator.languages → en-US. `?lang=` forces a locale
 * for the page load (QA links) and hides the selector. A change re-applies
 * `data-i18n` markup and every node bound with bindText/bindAttr, sets
 * <html lang>, and notifies onChange listeners so the HUD, board and open
 * screens re-render in place.
 */
(function (global, factory) {
  var api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { global.PARKWISE_I18N = api; api.init(); }
})(typeof self !== 'undefined' ? self : this, function (global) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

  var SRC = {};
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    ['en-GB', 'es', 'de', 'fr', 'pt', 'it'].forEach(function (f) { Object.assign(SRC, require('./locales/' + f + '.js')); });
  } else {
    SRC = (global && global.PARKWISE_LOCALES) || {};
  }
  function merge(a, b) { return Object.assign({}, a || {}, b || {}); }

  /** Locale → { English key: translation }. */
  var DICTS = {
    'en-US': {},
    'en-GB': SRC['en-GB'] || {},
    'es-419': SRC['es-419'] || {},
    'es-ES': merge(SRC['es-419'], SRC['es-ES']),
    'de-DE': SRC['de-DE'] || {},
    'fr-FR': SRC['fr-FR'] || {},
    'fr-CA': merge(SRC['fr-FR'], SRC['fr-CA']),
    'pt-BR': SRC['pt-BR'] || {},
    'it-IT': SRC['it-IT'] || {}
  };

  var lang = 'en-US';
  var dict = DICTS[lang];
  var listeners = [];
  var bound = typeof WeakMap === 'function' ? new WeakMap() : null;

  function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; });
  }

  /** Translate an English source string (unknown strings pass through). */
  function T(key, vars) {
    if (key == null) return '';
    var s = String(key);
    var out = Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s;
    return vars ? fmt(out, vars) : out;
  }

  /** Mark a string for extraction; translated later with T(). */
  function N(key) { return key; }

  /** A thunk that translates on every call (for bindText / el labels). */
  function L(key, vars) { return function () { return T(key, typeof vars === 'function' ? vars() : vars); }; }

  // Nodes whose text or attributes are computed by a function: re-run on every
  // language change. Marked with data-i18n-bound so a change finds them.
  function entry(node) {
    var e = bound.get(node);
    if (!e) { e = { text: null, attrs: {} }; bound.set(node, e); node.setAttribute('data-i18n-bound', ''); }
    return e;
  }
  function bindText(node, fn) {
    node.textContent = fn();
    if (bound) entry(node).text = fn;
    return node;
  }
  function bindAttr(node, name, fn) {
    node.setAttribute(name, fn());
    if (bound) entry(node).attrs[name] = fn;
    return node;
  }

  var htmlSource = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** Re-apply data-i18n (text), data-i18n-aria, data-i18n-placeholder, data-i18n-html and bound nodes. */
  function applyMarkup(root) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n]'), function (n) { n.textContent = T(n.getAttribute('data-i18n')); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-aria]'), function (n) { n.setAttribute('aria-label', T(n.getAttribute('data-i18n-aria'))); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-placeholder]'), function (n) { n.setAttribute('placeholder', T(n.getAttribute('data-i18n-placeholder'))); });
    // Rich text with inline markup: the key is the authored US-English innerHTML.
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-html]'), function (n) {
      if (!htmlSource) return;
      if (!htmlSource.has(n)) htmlSource.set(n, n.innerHTML.trim());
      n.innerHTML = T(htmlSource.get(n));
    });
    if (!bound) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-bound]'), function (n) {
      var e = bound.get(n);
      if (!e) return;
      if (e.text) n.textContent = e.text();
      Object.keys(e.attrs).forEach(function (a) { n.setAttribute(a, e.attrs[a]()); });
    });
  }

  function setLocale(next) {
    var resolved = DICTS[next] ? next : 'en-US';
    var changed = resolved !== lang;
    lang = resolved;
    dict = DICTS[lang];
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
      if (document.readyState !== 'loading') applyMarkup(document);
    }
    if (changed) listeners.slice().forEach(function (fn) { try { fn(lang); } catch (e) { if (global.console) global.console.error(e); } });
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  var language = null;
  /** Wire the StarHermit language preference (browser only). */
  function init() {
    var SHL = global && global.StarHermitLanguage;
    var forced = null;
    try { forced = new URLSearchParams(global.location.search).get('lang'); } catch (e) { /* opaque origin */ }
    var forcedLocale = forced && SHL ? SHL.match(forced, LOCALES) : null;
    if (!SHL) { setLocale('en-US'); return null; }
    language = SHL.create({
      game: 'parkwise', supported: LOCALES, panel: !forcedLocale,
      apply: function (locale) { setLocale(forcedLocale || locale); }
    });
    return language;
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { applyMarkup(document); });
  }

  return {
    LOCALES: LOCALES,
    DICTS: DICTS,
    T: T, N: N, L: L, fmt: fmt,
    lang: function () { return lang; },
    setLocale: setLocale,
    onChange: onChange,
    bindText: bindText,
    bindAttr: bindAttr,
    applyMarkup: applyMarkup,
    init: init,
    language: function () { return language; }
  };
});
