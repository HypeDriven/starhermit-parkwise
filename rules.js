'use strict';

// Parkwise rules engine — pure, deterministic, renderer-independent.
// Works in browser (window.PARKWISE_RULES) and Node (module.exports).
//
// Board: GRID x GRID cells. Vehicles slide along their facing axis.
// Vehicle: { id, x, y, len, ori ('h'|'v'), target }. (x,y) is the top-left cell.
// The target vehicle wins by reaching the exit on the right edge of exitRow.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PARKWISE_RULES = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

    const GRID = 6;
    const EXIT_ROW = 2; // 0-based row of the exit gate
    const SCHEMA_VERSION = 1;

    // ---- seeded RNG: mulberry32, separate streams for rules/deco/av ----
    function rng(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ---- serialization + hashing (fnv1a over canonical string) ----
    function stateKey(state) {
        return state.vehicles.map(v => v.x + ',' + v.y).join(';');
    }
    function serialize(state) {
        return JSON.stringify({
            v: SCHEMA_VERSION, grid: state.grid, exitRow: state.exitRow,
            vehicles: state.vehicles.map(v => [v.id, v.x, v.y, v.len, v.ori, v.target ? 1 : 0]),
            tick: state.tick, moves: state.moves,
        });
    }
    function hash(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }
    function stateHash(state) { return hash(serialize(state)); }

    function makeState(level) {
        // level: { grid?, exitRow?, vehicles: [{id,x,y,len,ori,target}] }
        const grid = level.grid || GRID;
        const state = {
            grid, exitRow: level.exitRow != null ? level.exitRow : EXIT_ROW,
            vehicles: level.vehicles.map(v => ({ id: v.id, x: v.x, y: v.y, len: v.len, ori: v.ori, target: !!v.target })),
            tick: 0, moves: 0,
        };
        const err = validateState(state);
        if (err) throw new Error('invalid level: ' + err);
        return state;
    }

    function validateState(state) {
        const occ = new Set();
        for (const v of state.vehicles) {
            if (v.len < 2 || v.len > 3) return 'bad length';
            if (v.ori !== 'h' && v.ori !== 'v') return 'bad orientation';
            const cells = cellsOf(v);
            for (const [x, y] of cells) {
                if (x < 0 || y < 0 || x >= state.grid || y >= state.grid) return 'out of bounds';
                const k = x + ',' + y;
                if (occ.has(k)) return 'overlap at ' + k;
                occ.add(k);
            }
        }
        if (!state.vehicles.some(v => v.target)) return 'no target vehicle';
        return null;
    }

    function cellsOf(v) {
        const out = [];
        for (let i = 0; i < v.len; i++) {
            out.push(v.ori === 'h' ? [v.x + i, v.y] : [v.x, v.y + i]);
        }
        return out;
    }

    function occupancy(state) {
        const g = new Array(state.grid * state.grid).fill(-1);
        state.vehicles.forEach((v, i) => {
            for (const [x, y] of cellsOf(v)) g[y * state.grid + x] = i;
        });
        return g;
    }

    // Legal actions: every (vehicle, dir, dist) slide along the facing axis.
    // dir: -1 = toward origin (left/up), +1 = away (right/down).
    function legalActions(state) {
        const g = occupancy(state);
        const acts = [];
        state.vehicles.forEach((v, i) => {
            for (const dir of [-1, 1]) {
                for (let dist = 1; dist < state.grid; dist++) {
                    const hx = v.ori === 'h' ? (dir < 0 ? v.x - dist : v.x + v.len - 1 + dist) : v.x;
                    const hy = v.ori === 'v' ? (dir < 0 ? v.y - dist : v.y + v.len - 1 + dist) : v.y;
                    if (hx < 0 || hy < 0 || hx >= state.grid || hy >= state.grid) break;
                    if (g[hy * state.grid + hx] !== -1) break;
                    acts.push({ v: i, dir, dist });
                }
            }
        });
        return acts;
    }

    // Reason a proposed move is illegal, or null if legal.
    function illegalReason(state, vIdx, dir, dist) {
        const v = state.vehicles[vIdx];
        if (!v) return 'no such vehicle';
        if (!Number.isInteger(dist) || dist < 1) return 'distance must be a positive integer';
        if (dir !== -1 && dir !== 1) return 'direction must be -1 or 1';
        const g = occupancy(state);
        for (let d = 1; d <= dist; d++) {
            const hx = v.ori === 'h' ? (dir < 0 ? v.x - d : v.x + v.len - 1 + d) : v.x;
            const hy = v.ori === 'v' ? (dir < 0 ? v.y - d : v.y + v.len - 1 + d) : v.y;
            if (hx < 0 || hy < 0 || hx >= state.grid || hy >= state.grid) return 'blocked by the lot edge';
            const occ = g[hy * state.grid + hx];
            if (occ !== -1) return 'blocked by another vehicle';
        }
        return null;
    }

    // Apply a validated move; returns a NEW state (input untouched).
    function applyMove(state, vIdx, dir, dist) {
        const reason = illegalReason(state, vIdx, dir, dist);
        if (reason) throw new Error('illegal move: ' + reason);
        const next = {
            grid: state.grid, exitRow: state.exitRow,
            vehicles: state.vehicles.map(v => ({ id: v.id, x: v.x, y: v.y, len: v.len, ori: v.ori, target: v.target })),
            tick: state.tick + 1, moves: state.moves + 1,
        };
        const v = next.vehicles[vIdx];
        if (v.ori === 'h') v.x += dir * dist; else v.y += dir * dist;
        return next;
    }

    function targetVehicle(state) { return state.vehicles.findIndex(v => v.target); }

    function isWin(state) {
        const t = state.vehicles[targetVehicle(state)];
        return t.ori === 'h' && t.y === state.exitRow && t.x + t.len === state.grid;
    }

    // Path the target still needs to clear: cells between its front and the exit.
    function exitBlockers(state) {
        const t = state.vehicles[targetVehicle(state)];
        const g = occupancy(state);
        const out = [];
        for (let x = t.x + t.len; x < state.grid; x++) {
            const i = g[state.exitRow * state.grid + x];
            if (i !== -1) out.push(i);
        }
        return out;
    }

    // ---- solver: BFS for optimal solution; bounded, deterministic ----
    function solve(state, maxNodes) {
        const cap = maxNodes || 40000;
        const start = stateKey(state);
        if (isWin(state)) return { depth: 0, firstMove: null };
        const seen = new Set([start]);
        const queue = [{ s: state, depth: 0, first: null }];
        let head = 0;
        while (head < queue.length && seen.size < cap) {
            const node = queue[head++];
            for (const a of legalActions(node.s)) {
                const ns = applyMove(node.s, a.v, a.dir, a.dist);
                const k = stateKey(ns);
                if (seen.has(k)) continue;
                seen.add(k);
                const first = node.first || a;
                if (isWin(ns)) return { depth: node.depth + 1, firstMove: first };
                queue.push({ s: ns, depth: node.depth + 1, first });
            }
        }
        return null; // unsolved within cap (treated as unsolvable by validators)
    }

    // ---- scoring: integers only; breakdown, never one bare total ----
    // components: base, parBonus, timeBonus, hintPenalty, invalidPenalty, challengeBonus
    function score(opts) {
        const par = Math.max(1, opts.par | 0);
        const moves = Math.max(0, opts.moves | 0);
        const seconds = Math.max(0, opts.seconds | 0);
        const hints = Math.max(0, opts.hints | 0);
        const invalid = Math.max(0, opts.invalid | 0);
        const won = !!opts.won;
        if (!won) return { base: 0, parBonus: 0, timeBonus: 0, hintPenalty: 0, invalidPenalty: 0, challengeBonus: 0, total: 0 };
        const base = 500;
        const parBonus = Math.max(0, (par * 3 - moves)) * 25; // rewarded for efficiency
        const timeBonus = Math.max(0, 600 - seconds) * 2;
        const hintPenalty = -150 * hints;
        const invalidPenalty = -10 * invalid;
        const challengeBonus = opts.challenge ? 500 : 0;
        const total = base + parBonus + timeBonus + hintPenalty + invalidPenalty + challengeBonus;
        return { base, parBonus, timeBonus, hintPenalty, invalidPenalty, challengeBonus, total: Math.max(0, total) };
    }

    // ---- replay envelope ----
    function makeReplay(meta, level, commands, terminal) {
        const initial = makeState(level);
        return {
            schema: SCHEMA_VERSION,
            build: meta.build || '1.0.0',
            contentVersion: meta.contentVersion || 1,
            mode: meta.mode, seed: meta.seed,
            initialHash: stateHash(initial),
            timestampOffset: meta.timestampOffset || 0,
            commands: commands.slice(),
            stateHashes: meta.stateHashes || [],
            terminal: terminal || null,
        };
    }

    // Replay commands from a level; returns { state, hashes, ok, error }.
    function replay(level, commands) {
        let state = makeState(level);
        const hashes = [stateHash(state)];
        try {
            for (const c of commands) {
                if (c.type !== 'move') throw new Error('unknown command ' + c.type);
                state = applyMove(state, c.v, c.dir, c.dist);
                hashes.push(stateHash(state));
            }
            return { state, hashes, ok: true, error: null };
        } catch (e) {
            return { state, hashes, ok: false, error: String(e.message || e) };
        }
    }

    return {
        GRID, EXIT_ROW, SCHEMA_VERSION,
        rng, hash, serialize, stateKey, stateHash,
        makeState, validateState, cellsOf, occupancy,
        legalActions, illegalReason, applyMove,
        targetVehicle, isWin, exitBlockers, solve, score,
        makeReplay, replay,
    };
});
