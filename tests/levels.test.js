'use strict';
/* levels.js (tools/gen-levels.mjs) holds content.js's generated lots: the
 * rows decode to legal, unsolved lots whose par is the optimal solution depth,
 * and a sample is regenerated and compared (`node tools/gen-levels.mjs
 * --verify` regenerates every row, ~11 min on 4 cores). */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../rules.js');
const C = require('../content.js');
const L = require('../levels.js');

function check(entry, label) {
  const s = R.makeState(entry.level);
  assert.equal(R.isWin(s), false, label + ' starts won');
  assert.ok(R.exitBlockers(s).length > 0, label + ' needs an unblock');
  const sol = R.solve(s, 40000);
  assert.ok(sol, label + ' unsolvable');
  assert.equal(sol.depth, entry.par, label + ' par');
}

test('the table covers 40 stages, 20 practice lots per difficulty and the dailies of 2026-10-01 … 2028-12-31', () => {
  assert.equal(L.journey.length, 40);
  assert.deepEqual(L.practice.map((p) => p.length), [20, 20, 20]);
  assert.ok(L.daily['2026-10-01'] && L.daily['2028-12-31']);
  assert.equal(Object.keys(L.daily).length, 823);
  assert.ok(C.dailyReady('2027-05-05') && !C.dailyReady('2029-01-01'));
  assert.ok(C.practiceReady(2, 19) && !C.practiceReady(2, 20));
});

test('every journey and practice row is a legal lot with its optimal par', () => {
  for (let i = 0; i < 40; i++) check(C.journeyLevel(i), 'stage ' + (i + 1));
  for (let t = 0; t < 3; t++) for (let a = 0; a < 20; a++) check(C.practiceLevel(t)(a), `practice ${t}/${a}`);
});

test('a sample of dailies is legal with its optimal par', () => {
  Object.keys(L.daily).filter((d, i) => i % 9 === 0).forEach((d) => check(C.dailyLevel(d), 'daily ' + d));
});

test('sampled rows equal the generator', () => {
  for (const i of [0, 1, 2, 3, 4, 5]) assert.equal(C.generate.journey(i), L.journey[i], 'stage ' + (i + 1));
  for (let a = 0; a < 20; a++) assert.equal(C.generate.practice(0, a), L.practice[0][a], 'easy ' + a);
  for (const d of ['2026-10-28', '2027-02-14', '2028-12-31']) assert.equal(C.generate.daily(d), L.daily[d], d);
});

test('lots outside the table are generated deterministically', () => {
  const a = C.dailyLevel('2031-03-04'), b = C.dailyLevel('2031-03-04');
  assert.deepEqual(a.level, b.level);
  check(a, 'daily 2031-03-04');
  const p = C.practiceLevel(0)(25);
  check(p, 'practice 0/25');
});
