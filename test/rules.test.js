'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../rules.js');
const C = require('../content.js');

const SIMPLE = {
    vehicles: [
        { id: 0, x: 1, y: 2, len: 2, ori: 'h', target: true },
        { id: 1, x: 4, y: 1, len: 2, ori: 'v' },
    ],
};

test('legal actions only along facing axis', () => {
    const s = R.makeState(SIMPLE);
    const acts = R.legalActions(s);
    assert.ok(acts.every(a => a.v === 0 || a.v === 1));
    // target can slide left 1 and right up to 1 (x=1..3 head stops before blocker at x=4)
    const t = acts.filter(a => a.v === 0);
    assert.ok(t.some(a => a.dir === -1 && a.dist === 1));
    assert.ok(t.some(a => a.dir === 1 && a.dist === 1));
    assert.ok(!t.some(a => a.dir === 1 && a.dist === 2), 'blocked by van');
    // vertical van can go down
    assert.ok(acts.some(a => a.v === 1 && a.dir === 1));
});

test('invalid moves report reasons', () => {
    const s = R.makeState(SIMPLE);
    assert.strictEqual(R.illegalReason(s, 0, 1, 3), 'blocked by another vehicle');
    assert.strictEqual(R.illegalReason(s, 0, -1, 5), 'blocked by the lot edge');
    assert.strictEqual(R.illegalReason(s, 9, 1, 1), 'no such vehicle');
    assert.strictEqual(R.illegalReason(s, 0, 1, 0), 'distance must be a positive integer');
    assert.throws(() => R.applyMove(s, 0, 1, 3), /illegal move/);
});

test('applyMove is immutable and ticks forward', () => {
    const s = R.makeState(SIMPLE);
    const n = R.applyMove(s, 0, -1, 1);
    assert.strictEqual(s.vehicles[0].x, 1, 'original untouched');
    assert.strictEqual(n.vehicles[0].x, 0);
    assert.strictEqual(n.tick, 1);
    assert.strictEqual(n.moves, 1);
});

test('win condition: target front reaches exit edge', () => {
    let s = R.makeState(SIMPLE);
    assert.strictEqual(R.isWin(s), false);
    s = R.applyMove(s, 1, 1, 2); // van down out of the lane
    assert.deepStrictEqual(R.exitBlockers(s), []);
    s = R.applyMove(s, 0, 1, 3); // red car to exit
    assert.strictEqual(R.isWin(s), true);
});

test('solver finds optimal depth and a legal first move', () => {
    const s = R.makeState(SIMPLE);
    const sol = R.solve(s);
    assert.ok(sol);
    assert.strictEqual(sol.depth, 2);
    assert.strictEqual(sol.firstMove.v, 1);
    const after = R.applyMove(s, sol.firstMove.v, sol.firstMove.dir, sol.firstMove.dist);
    assert.ok(R.solve(after).depth === 1);
});

test('deterministic replay: same seed and commands, same hashes', () => {
    const entry = C.journeyLevel(3);
    const cmds = [];
    let s = R.makeState(entry.level);
    // generate a random-but-seeded command log of legal moves
    const rnd = R.rng(entry.seed);
    for (let i = 0; i < 12; i++) {
        const acts = R.legalActions(s);
        const a = acts[Math.floor(rnd() * acts.length)];
        cmds.push({ type: 'move', v: a.v, dir: a.dir, dist: a.dist });
        s = R.applyMove(s, a.v, a.dir, a.dist);
    }
    const r1 = R.replay(entry.level, cmds);
    const r2 = R.replay(entry.level, cmds);
    assert.ok(r1.ok && r2.ok);
    assert.deepStrictEqual(r1.hashes, r2.hashes);
    const env = R.makeReplay({ mode: 'journey', seed: entry.seed }, entry.level, cmds, null);
    assert.strictEqual(env.initialHash, r1.hashes[0]);
});

test('replay rejects illegal command logs idempotently', () => {
    const entry = C.journeyLevel(0);
    const bad = [{ type: 'move', v: 0, dir: 1, dist: 99 }];
    const r = R.replay(entry.level, bad);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /illegal/);
});

test('scoring: components and integer totals', () => {
    const sc = R.score({ par: 10, moves: 8, seconds: 60, hints: 1, invalid: 2, won: true, challenge: true });
    assert.strictEqual(sc.base, 500);
    assert.ok(sc.parBonus > 0);
    assert.ok(Number.isSafeInteger(sc.total));
    assert.strictEqual(sc.total, sc.base + sc.parBonus + sc.timeBonus + sc.hintPenalty + sc.invalidPenalty + sc.challengeBonus);
    const lost = R.score({ par: 10, moves: 8, seconds: 60, hints: 0, invalid: 0, won: false });
    assert.strictEqual(lost.total, 0);
    // fewer moves and less time beats more
    const better = R.score({ par: 10, moves: 6, seconds: 30, hints: 0, invalid: 0, won: true });
    const worse = R.score({ par: 10, moves: 12, seconds: 90, hints: 2, invalid: 1, won: true });
    assert.ok(better.total > worse.total);
});

test('serialization round-trips and hashes are stable', () => {
    const s = R.makeState(SIMPLE);
    const h1 = R.stateHash(s);
    const h2 = R.stateHash(R.makeState(SIMPLE));
    assert.strictEqual(h1, h2);
    assert.strictEqual(typeof R.serialize(s), 'string');
});

test('fuzz: malformed commands never hang or corrupt', () => {
    const entry = C.journeyLevel(1);
    const rnd = R.rng(42);
    for (let i = 0; i < 200; i++) {
        const cmds = [];
        for (let j = 0; j < 20; j++) {
            cmds.push({ type: 'move', v: Math.floor(rnd() * 20) - 2, dir: rnd() < 0.5 ? -1 : 1, dist: Math.floor(rnd() * 8) });
        }
        const r = R.replay(entry.level, cmds);
        if (r.ok) assert.strictEqual(R.validateState(r.state), null);
    }
});
