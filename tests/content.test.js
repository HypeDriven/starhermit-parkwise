'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../rules.js');
const C = require('../content.js');

test('tutorials are legal and solvable', () => {
    for (const t of C.TUTORIALS) {
        const errs = C.validateEntry({ id: t.id, seed: 1, level: t.level, par: 1 });
        assert.deepStrictEqual(errs, [], t.id + ': ' + errs.join('; '));
    }
});

test('all 40 journey stages validate: legal, solvable, bounded, par set', () => {
    for (let i = 0; i < C.JOURNEY_COUNT; i++) {
        const entry = C.journeyLevel(i);
        const errs = C.validateEntry(entry);
        assert.deepStrictEqual(errs, [], 'stage ' + i + ': ' + errs.join('; '));
        const sol = R.solve(R.makeState(entry.level));
        assert.strictEqual(sol.depth, entry.par, 'par equals optimal depth');
    }
});

test('journey generation is deterministic per index', () => {
    const a = C.journeyLevel(7);
    const b = C.journeyLevel(7);
    assert.strictEqual(R.serialize(R.makeState(a.level)), R.serialize(R.makeState(b.level)));
    assert.strictEqual(a.seed, b.seed);
});

test('difficulty ramps by solution depth', () => {
    const early = C.journeyLevel(0), late = C.journeyLevel(39);
    assert.ok(late.par > early.par, 'late stages deeper than early');
});

test('daily level is deterministic for a day and differs across days', () => {
    const d1 = C.dailyLevel('2026-08-30');
    const d1b = C.dailyLevel('2026-08-30');
    const d2 = C.dailyLevel('2026-08-31');
    assert.strictEqual(R.serialize(R.makeState(d1.level)), R.serialize(R.makeState(d1b.level)));
    assert.notStrictEqual(d1.seed, d2.seed);
    assert.deepStrictEqual(C.validateEntry(d1), []);
});

test('practice tiers produce solvable lots at all difficulties', () => {
    for (let tier = 0; tier < 3; tier++) {
        const gen = C.practiceLevel(tier);
        for (let attempt = 0; attempt < 3; attempt++) {
            const e = gen(attempt);
            assert.deepStrictEqual(C.validateEntry(e), [], 'tier ' + tier + ' attempt ' + attempt);
        }
    }
});

test('challenge entries carry constraints and validate', () => {
    for (let i = 0; i < 6; i++) {
        const e = C.challengeLevel(i);
        assert.ok(e.challenge && e.challenge.kind);
        if (e.challenge.kind === 'move-limit') assert.ok(e.challenge.moveLimit > e.par);
        if (e.challenge.kind === 'speed') assert.ok(e.challenge.timeLimit > 0);
        assert.deepStrictEqual(C.validateEntry(e), []);
    }
});

test('five themes with distinct ids and full palettes', () => {
    assert.strictEqual(C.THEMES.length, 5);
    const ids = new Set(C.THEMES.map(t => t.id));
    assert.strictEqual(ids.size, 5);
    for (const t of C.THEMES) assert.ok(t.palette.length >= 8);
});

test('full content validation report passes', () => {
    const report = C.validateAll();
    assert.strictEqual(report.ok, true, JSON.stringify(report).slice(0, 500));
});
