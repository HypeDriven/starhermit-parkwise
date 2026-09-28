'use strict';

const test = require('node:test');
const assert = require('node:assert');
const G = require('../gfx.js');

test('detectPreset maps GPU strings to tiers', () => {
    assert.strictEqual(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
    assert.strictEqual(G.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
    assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
    assert.strictEqual(G.detectPreset('Apple M2'), 'high');
    assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
    assert.strictEqual(G.detectPreset('Adreno (TM) 640'), 'balanced');
    assert.strictEqual(G.detectPreset(''), 'balanced');
});

test('autoPreset caps touch devices at balanced', () => {
    assert.strictEqual(G.autoPreset('Apple M2', true), 'balanced');
    assert.strictEqual(G.autoPreset('Apple M2', false), 'high');
    assert.strictEqual(G.autoPreset('SwiftShader', true), 'low');
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
