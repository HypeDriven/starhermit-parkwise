'use strict';

const test = require('node:test');
const assert = require('node:assert');
// gpu-level.js is a classic script in the page (window.StarHermitGpu); install it the same way here.
globalThis.StarHermitGpu = require('../gpu-level.js');
const G = require('../gfx.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
    assert.strictEqual(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
    assert.strictEqual(G.detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
    assert.strictEqual(G.detectPreset('', DESK), 'low', 'no WebGL');
    assert.strictEqual(G.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
    assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
    assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
    assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
    assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
    assert.strictEqual(G.detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
    assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
    for (const [p, lv] of Object.entries(G.LEVELS)) assert.strictEqual(G.presetForLevel(lv), p);
    assert.strictEqual(G.presetForLevel(3), 'low');
    assert.strictEqual(G.presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
    assert.strictEqual(G.detectPreset('Adreno (TM) 740', PHONE), 'balanced');
    assert.ok(G.detectLevel('Adreno (TM) 740', PHONE) <= 9);
    assert.strictEqual(G.autoPreset('Apple M2', true), 'balanced', 'boolean mobile flag still caps');
    assert.strictEqual(G.detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
    const keys = ['material', 'curve', 'bevel', 'texture', 'skyline', 'dust', 'confetti', 'bloomRes', 'aoRes'];
    for (const p of G.PRESETS) for (const k of keys) assert.ok(G.BUDGETS[p][k] != null, `${p}.${k}`);
    for (let i = 1; i < G.PRESETS.length; i++) for (const k of keys) {
        if (typeof G.BUDGETS.low[k] === 'number') assert.ok(G.BUDGETS[G.PRESETS[i]][k] >= G.BUDGETS[G.PRESETS[i - 1]][k], `${G.PRESETS[i]}.${k}`);
    }
    assert.deepStrictEqual(G.PRESETS.map(p => G.BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
    assert.deepStrictEqual(G.PRESETS.map(p => G.BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
    assert.deepStrictEqual(G.resolve({ preset: 'high' }, 'low', 10).budget, G.BUDGETS.high, 'floor level = the tuned budget');
    assert.deepStrictEqual(G.resolve({ preset: 'ultra' }, 'low', 0).budget, G.resolve({ preset: 'ultra' }, 'ultra', 17).budget);
    assert.ok(G.budgetFor('balanced', 9).dust > G.budgetFor('balanced', 4).dust, 'counts scale up within the preset');
    assert.ok(G.budgetFor('ultra', 20).dust <= G.DUST_MAX && G.budgetFor('ultra', 20).confetti <= G.CONFETTI_MAX);
    assert.strictEqual(G.resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('graphics summary level label in every locale', () => {
    for (const loc of Object.keys(G.STRINGS)) assert.match(G.strings(loc).level.replace('{n}', 7), /7$/, loc);
});

test('resolve: auto uses detected preset, explicit preset wins, overrides apply', () => {
    const auto = G.resolve({ preset: 'auto' }, 'low');
    assert.strictEqual(auto.preset, 'low');
    assert.strictEqual(auto.auto, true);
    assert.strictEqual(auto.shadows, 'off');
    assert.strictEqual(auto.post, false, 'Low renders without post-processing');

    const high = G.resolve({ preset: 'high' }, 'low');
    assert.strictEqual(high.preset, 'high');
    assert.strictEqual(high.auto, false);
    assert.strictEqual(high.shadows, G.presetTier('high', 'shadows'));
    assert.strictEqual(high.post, true);

    const over = G.resolve({ preset: 'high', bloom: 'off', shadows: 'high', detail: 'bogus' }, 'low');
    assert.strictEqual(over.bloom, 'off');
    assert.strictEqual(over.shadows, 'high');
    assert.strictEqual(over.detail, G.presetTier('high', 'detail'), 'invalid override falls back to preset');
});

test('resolve clamps render scale to 50–200%', () => {
    assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 5 }).scale, 2);
    assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 0.1 }).scale, 0.5);
    assert.strictEqual(G.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
    assert.strictEqual(G.resolve({}).adaptive, true);
    assert.strictEqual(G.resolve({ adaptive: false, show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
    const s = G.withPreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, show_fps: true }, 'low');
    assert.deepStrictEqual(s, { preset: 'low', render_scale: 1.5, show_fps: true });
    assert.strictEqual(G.withPreset({}, 'nonsense').preset, 'auto');
});

test('describe summarises cost; every locale has every panel string', () => {
    const d = G.describe(G.resolve({ preset: 'high' }), [1280, 720]);
    assert.match(d, /2048² shadows/);
    assert.match(d, /1280×720 px$/);
    assert.match(G.describe(G.resolve({ preset: 'low' })), /^no shadows/);
    for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
        const S = G.STRINGS[loc];
        assert.ok(S, loc);
        for (const k of Object.keys(G.STRINGS['en-US'])) assert.ok(S[k], `${loc}.${k}`);
        for (const cat of Object.keys(G.CATEGORIES)) {
            assert.ok(S.cats[cat], `${loc} category ${cat}`);
            for (const t of G.CATEGORIES[cat]) assert.ok(S.tiers[t], `${loc} tier ${t}`);
        }
        for (const p of G.PRESETS) assert.ok(S.tiers[p], `${loc} preset ${p}`);
    }
    assert.strictEqual(G.pickLocale('de'), 'de-DE');
    assert.strictEqual(G.pickLocale('es-MX'), 'es-419');
    assert.strictEqual(G.pickLocale('fr-CA'), 'fr-CA');
    assert.strictEqual(G.pickLocale('en-AU'), 'en-GB');
    assert.strictEqual(G.pickLocale('ja-JP'), 'en-US');
});
