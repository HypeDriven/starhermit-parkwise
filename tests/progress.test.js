'use strict';
/* progress.js: the save's progress document, its two-device merge (the
 * browser build's mergeProgress), the old cloud doc's migration and the
 * game's options. The engine's saves / settings calls around it
 * (native/platform.ts) need a signed-in session and are not live-tested here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../progress.js');

test('normalize: defaults for missing or malformed fields', () => {
  assert.deepEqual(P.normalizeProgress(null), P.emptyProgress());
  const p = P.normalizeProgress({ journeyUnlocked: 99, wins: -3, stars: { a: 2, b: 'x' }, tutorialsDone: ['learn-slide', 7], lastDaily: 5 });
  assert.equal(p.journeyUnlocked, 39);
  assert.equal(p.wins, 0);
  assert.deepEqual(p.stars, { a: 2 });
  assert.deepEqual(p.tutorialsDone, ['learn-slide']);
  assert.equal(p.lastDaily, null);
});

test('merge keeps the better record of each and drops nothing', () => {
  const a = { journeyUnlocked: 5, wins: 10, winStreak: 1, stars: { 'journey-1': 3, 'journey-2': 1 }, tutorialsDone: ['learn-slide'],
    achievements: { first_completion: 200 }, dailiesDone: { '2026-10-01': 900 }, lastDaily: '2026-10-01', bestScores: { 'daily:2026-10-01': 900 } };
  const b = { journeyUnlocked: 3, wins: 12, winStreak: 4, stars: { 'journey-2': 2 }, tutorialsDone: ['learn-blocked', 'learn-slide'],
    achievements: { first_completion: 100, streak_3: 300 }, dailiesDone: { '2026-10-01': 800, '2026-10-02': 700 }, lastDaily: '2026-10-02', bestScores: { 'journey:5150': 1500 } };
  const m = P.mergeProgress(a, b);
  assert.equal(m.journeyUnlocked, 5);
  assert.equal(m.wins, 12);
  assert.equal(m.winStreak, 4);
  assert.deepEqual(m.stars, { 'journey-1': 3, 'journey-2': 2 });
  assert.deepEqual(m.tutorialsDone.sort(), ['learn-blocked', 'learn-slide']);
  assert.deepEqual(m.achievements, { first_completion: 100, streak_3: 300 });
  assert.deepEqual(m.dailiesDone, { '2026-10-01': 900, '2026-10-02': 700 });
  assert.equal(m.lastDaily, '2026-10-02');
  assert.deepEqual(m.bestScores, { 'daily:2026-10-01': 900, 'journey:5150': 1500 });
  assert.ok(P.same(P.mergeProgress(m, m), m), 'merging with itself changes nothing');
  assert.ok(P.same(P.mergeProgress(a, b), P.mergeProgress(b, a)), 'order does not matter');
});

test('the browser build\'s cloud doc migrates: progress and the game options', () => {
  const old = JSON.stringify({
    savedAt: 1760000000000,
    settings: { volumes: { music: 0.2 }, muted: true, theme: 'night', graphics: { preset: 'high' }, captions: false, holdDrag: false, lefty: true, reducedMotion: true },
    progress: { journeyUnlocked: 7, wins: 9, stars: { 'journey-3': 3 }, tutorialsDone: [], achievements: {}, dailiesDone: {}, lastDaily: null, bestScores: {} },
  });
  const d = P.readForeign(old);
  assert.equal(d.progress.journeyUnlocked, 7);
  assert.deepEqual(d.options, { theme: 'night', captions: false, holdDrag: false, lefty: true });
  assert.equal(P.readForeign('not json'), null);
  assert.deepEqual(P.readForeign(JSON.stringify({ settings: { theme: 'mars' } })).options, {});
});

test('options: only known values pass', () => {
  assert.equal(P.pickOption('theme', 'dusk'), 'dusk');
  assert.equal(P.pickOption('theme', null), '');
  assert.equal(P.pickOption('theme', 'mars'), undefined);
  assert.equal(P.pickOption('lefty', 'yes'), undefined);
  assert.equal(P.pickOption('captions', false), false);
  assert.ok(P.BROWSER_KEYS.includes('graphics') && P.BROWSER_KEYS.includes('volumes'));
});
