'use strict';

// Parkwise content: versioned levels, tutorials, challenges, themes, and a
// deterministic, validated level generator. Works in browser and Node.
(function (root, factory) {
    const R = (typeof module !== 'undefined' && module.exports) ? require('./rules.js') : root.PARKWISE_RULES;
    const api = factory(R);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PARKWISE_CONTENT = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {

    const CONTENT_VERSION = 1;
    const GRID = R.GRID;

    // ---- five visual themes (color-vision-safe gameplay accents) ----
    const THEMES = [
        { id: 'dawn', name: 'Dawn', sky: 0xffd9a0, fog: 0xffe9c9, ground: 0xb8683c, slab: 0x8a94a6, line: 0xf5ede0, parapet: 0x7c4a2d, key: 0xfff1d6, target: 0xe53935, palette: [0x1e88e5, 0xfdd835, 0x43a047, 0x8e24aa, 0x00acc1, 0xfb8c00, 0x546e7a, 0x6d4c41, 0xc0ca33, 0x5e35b1] },
        { id: 'day', name: 'Day', sky: 0x8fd3ff, fog: 0xcfeaff, ground: 0x5aa7d6, slab: 0x9aa5b5, line: 0xffffff, parapet: 0x3f6f9e, key: 0xffffff, target: 0xe53935, palette: [0x1e88e5, 0xfdd835, 0x43a047, 0x8e24aa, 0x00acc1, 0xfb8c00, 0x546e7a, 0x6d4c41, 0xc0ca33, 0x5e35b1] },
        { id: 'dusk', name: 'Dusk', sky: 0xff9e7a, fog: 0xffc4a3, ground: 0x9e5470, slab: 0x7d8296, line: 0xffe6d6, parapet: 0x5e3a55, key: 0xffd0b0, target: 0xe53935, palette: [0x1e88e5, 0xfdd835, 0x43a047, 0x8e24aa, 0x00acc1, 0xfb8c00, 0x546e7a, 0x6d4c41, 0xc0ca33, 0x5e35b1] },
        { id: 'night', name: 'Night', sky: 0x0f2c4d, fog: 0x1a3a5f, ground: 0x28496b, slab: 0x3c4a63, line: 0xd6e6ff, parapet: 0x1c2f47, key: 0xaac4ff, target: 0xff5252, palette: [0x42a5f5, 0xffee58, 0x66bb6a, 0xba68c8, 0x26c6da, 0xffa726, 0x90a4ae, 0x8d6e63, 0xd4e157, 0x7e57c2] },
        { id: 'contrast', name: 'Contrast', sky: 0x101418, fog: 0x101418, ground: 0x1d2530, slab: 0x2b3644, line: 0xffffff, parapet: 0x0b0e12, key: 0xffffff, target: 0xff2d2d, palette: [0x00c8ff, 0xffe600, 0x00e676, 0xe040fb, 0x00e5ff, 0xff9100, 0xb0bec5, 0xffffff, 0xc6ff00, 0x7c4dff] },
    ];

    // ---- authored tutorial stages (Learn mode): one rule at a time ----
    const TUTORIALS = [
        {
            id: 'learn-slide', title: 'Slide a vehicle',
            text: 'Vehicles only move along the way they face. Drag the red car, or select it and press an arrow key, to slide it right to the exit gate.',
            hintVehicle: 0,
            level: { vehicles: [
                { id: 0, x: 1, y: 2, len: 2, ori: 'h', target: true },
                { id: 1, x: 0, y: 0, len: 2, ori: 'h' },
            ] },
        },
        {
            id: 'learn-blocked', title: 'Blocked paths',
            text: 'A vehicle cannot pass through another. Slide the blue van UP out of the exit lane, then drive the red car out.',
            hintVehicle: 1,
            level: { vehicles: [
                { id: 0, x: 1, y: 2, len: 2, ori: 'h', target: true },
                { id: 1, x: 4, y: 1, len: 2, ori: 'v' },
            ] },
        },
        {
            id: 'learn-axis', title: 'Facing matters',
            text: 'Upright vehicles move vertically, sideways ones horizontally — never diagonally, never rotating. Free the exit lane.',
            hintVehicle: 1,
            level: { vehicles: [
                { id: 0, x: 0, y: 2, len: 2, ori: 'h', target: true },
                { id: 1, x: 3, y: 2, len: 3, ori: 'v' },
                { id: 2, x: 4, y: 4, len: 2, ori: 'h' },
            ] },
        },
        {
            id: 'learn-plan', title: 'Plan two steps',
            text: 'Sometimes you must move a blocker, then the blocker’s blocker. Clear the lane and park the red car by the gate.',
            hintVehicle: 2,
            level: { vehicles: [
                { id: 0, x: 0, y: 2, len: 2, ori: 'h', target: true },
                { id: 1, x: 3, y: 0, len: 2, ori: 'v' },
                { id: 2, x: 3, y: 3, len: 2, ori: 'v' },
                { id: 3, x: 4, y: 0, len: 2, ori: 'h' },
            ] },
        },
    ];

    // ---- deterministic level generator (Journey / Practice / Daily) ----
    // Difficulty from solution depth + vehicle count, not just bigger numbers.
    function difficultyFor(i) {
        const t = i / 39;
        return {
            vehicles: Math.round(7 + t * 5),                       // 7..12
            minDepth: Math.max(2, Math.round(3 + t * 11)),          // 3..14
            maxDepth: Math.round(8 + t * 18),                       // 8..26
            mastery: (i + 1) % 10 === 0,                            // periodic mastery stages
        };
    }

    function tryGenerate(seed, cfg) {
        const rnd = R.rng(seed);
        for (let attempt = 0; attempt < 120; attempt++) {
            const vehicles = [];
            const used = new Set();
            const tk = 2 + Math.floor(rnd() * 3); // target x in 2..4 (never pre-won)
            const target = { id: 0, x: tk - 2, y: R.EXIT_ROW, len: 2, ori: 'h', target: true };
            vehicles.push(target);
            for (const [x, y] of R.cellsOf(target)) used.add(x + ',' + y);
            let placed = 1;
            let guard = 0;
            while (placed < cfg.vehicles && guard++ < 400) {
                const ori = rnd() < 0.5 ? 'h' : 'v';
                const len = rnd() < 0.72 ? 2 : 3;
                const maxX = ori === 'h' ? GRID - len : GRID - 1;
                const maxY = ori === 'v' ? GRID - len : GRID - 1;
                const x = Math.floor(rnd() * (maxX + 1));
                const y = Math.floor(rnd() * (maxY + 1));
                const v = { id: placed, x, y, len, ori, target: false };
                const cells = R.cellsOf(v);
                if (cells.some(([cx, cy]) => used.has(cx + ',' + cy))) continue;
                // keep some vehicles out of the exit lane for variety balance
                vehicles.push(v);
                for (const [cx, cy] of cells) used.add(cx + ',' + cy);
                placed++;
            }
            if (placed < cfg.vehicles) continue;
            const level = { vehicles };
            let state;
            try { state = R.makeState(level); } catch (e) { continue; }
            if (R.isWin(state)) continue;
            if (R.exitBlockers(state).length === 0) continue; // must require at least one unblock
            const sol = R.solve(state, 25000);
            if (!sol) continue;
            if (sol.depth < cfg.minDepth || sol.depth > cfg.maxDepth) continue;
            return { level, par: sol.depth };
        }
        return null;
    }

    const JOURNEY_COUNT = 40;
    const journeyCache = new Map();

    function journeyLevel(index) {
        if (journeyCache.has(index)) return journeyCache.get(index);
        const cfg = difficultyFor(index);
        const seed = 0x5150 + index * 7919;
        let made = tryGenerate(seed, cfg);
        if (!made) made = tryGenerate(seed + 1, { vehicles: cfg.vehicles, minDepth: 2, maxDepth: cfg.maxDepth + 6 });
        if (!made) throw new Error('content generator failed for stage ' + index);
        const entry = {
            id: 'journey-' + (index + 1), version: CONTENT_VERSION, seed,
            level: made.level, par: made.par,
            mechanics: ['slide'], tutorial: index === 0,
            theme: THEMES[Math.floor(index / 8) % THEMES.length].id,
            mastery: cfg.mastery,
        };
        journeyCache.set(index, entry);
        return entry;
    }

    function dailySeed(dayKey) {
        // dayKey: YYYY-MM-DD (UTC). Immutable once published.
        return R.hash('parkwise-daily-' + dayKey).slice(0, 8);
    }

    function dailyLevel(dayKey) {
        const seed = parseInt(dailySeed(dayKey), 16);
        const made = tryGenerate(seed, { vehicles: 10, minDepth: 8, maxDepth: 20 }) ||
            tryGenerate(seed + 1, { vehicles: 9, minDepth: 5, maxDepth: 24 });
        if (!made) throw new Error('daily generator failed for ' + dayKey);
        return {
            id: 'daily-' + dayKey, version: CONTENT_VERSION, seed,
            level: made.level, par: made.par, mechanics: ['slide'], tutorial: false,
            theme: THEMES[seed % THEMES.length].id, mastery: false, day: dayKey,
        };
    }

    function practiceLevel(tier) {
        // tier 0 easy / 1 medium / 2 hard; seed rotates by attempt count
        const cfgs = [
            { vehicles: 7, minDepth: 3, maxDepth: 8 },
            { vehicles: 9, minDepth: 7, maxDepth: 14 },
            { vehicles: 12, minDepth: 12, maxDepth: 24 },
        ];
        const cfg = cfgs[Math.max(0, Math.min(2, tier | 0))];
        return function (attempt) {
            const seed = 0xC0FFEE + tier * 100003 + attempt * 31337;
            const made = tryGenerate(seed, cfg) || tryGenerate(seed + 7, { vehicles: cfg.vehicles, minDepth: 2, maxDepth: cfg.maxDepth + 8 });
            if (!made) throw new Error('practice generator failed');
            return {
                id: 'practice-' + tier + '-' + attempt, version: CONTENT_VERSION, seed,
                level: made.level, par: made.par, mechanics: ['slide'], tutorial: false,
                theme: THEMES[(seed + attempt) % THEMES.length].id, mastery: false,
            };
        };
    }

    // Challenge mode: constrained goals over generated layouts.
    function challengeLevel(index) {
        const base = journeyLevel(8 + (index % 4) * 8); // drawn from mastery band
        const kinds = ['move-limit', 'speed', 'no-hint'];
        const kind = kinds[index % kinds.length];
        return {
            id: 'challenge-' + kind + '-' + index, version: CONTENT_VERSION,
            seed: base.seed + index, level: base.level, par: base.par,
            mechanics: ['slide'], tutorial: false, theme: base.theme, mastery: true,
            challenge: {
                kind,
                moveLimit: kind === 'move-limit' ? base.par + 2 : null,
                timeLimit: kind === 'speed' ? 45 : null, // seconds
                noHint: kind === 'no-hint',
            },
        };
    }

    // ---- offline validators: legality, reachability, bounded duration ----
    function validateEntry(entry) {
        const errors = [];
        let state;
        try { state = R.makeState(entry.level); } catch (e) { return ['illegal initial state: ' + e.message]; }
        if (R.isWin(state)) errors.push('starts already won');
        const sol = R.solve(state, 40000);
        if (!sol) errors.push('goal unreachable (soft lock)');
        else if (sol.depth > 60) errors.push('solution too long (unbounded duration)');
        if (!entry.id || !Number.isInteger(entry.seed)) errors.push('missing id/seed');
        if (!(entry.par > 0)) errors.push('missing par');
        return errors;
    }

    function validateAll() {
        const report = { tutorials: {}, journey: {}, challenges: {}, ok: true };
        TUTORIALS.forEach((t, i) => {
            const errs = validateEntry({ id: t.id, seed: i, level: t.level, par: 1 });
            report.tutorials[t.id] = errs;
            if (errs.length) report.ok = false;
        });
        for (let i = 0; i < JOURNEY_COUNT; i++) {
            const errs = validateEntry(journeyLevel(i));
            if (errs.length) { report.journey[i] = errs; report.ok = false; }
        }
        for (let i = 0; i < 6; i++) {
            const errs = validateEntry(challengeLevel(i));
            if (errs.length) { report.challenges[i] = errs; report.ok = false; }
        }
        return report;
    }

    return {
        CONTENT_VERSION, THEMES, TUTORIALS, JOURNEY_COUNT,
        difficultyFor, journeyLevel, dailyLevel, dailySeed, practiceLevel, challengeLevel,
        validateEntry, validateAll,
    };
});
