'use strict';

// Parkwise audio: WebAudio synth, bus-based mixing, optional authored samples.
// Authored one-shots in sfx/ (see sfx/manifest.json) are preferred per event;
// the built-in synthesis below remains the fallback while samples load or fail.
// Buses: music, effects, ambience, voice(=UI cues). Works in browser and Node
// (Node gets a silent stub so tests can import it).
(function (root, factory) {
    const api = factory(typeof window !== 'undefined' ? window : null);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PARKWISE_AUDIO = api;
})(typeof self !== 'undefined' ? self : globalThis, function (win) {

    let ctx = null;
    let buses = null;       // { music, effects, ambience, voice } -> master
    let master = null;
    let volumes = { music: 0.6, effects: 0.8, ambience: 0.4, voice: 0.7 };
    let muted = false;
    let musicTimer = null;
    let ambienceNode = null;
    let captionCb = null;   // accessibility: text cues for meaningful audio
    let bar = 0;

    function available() { return !!(win && (win.AudioContext || win.webkitAudioContext)); }

    function ensure() {
        if (!available()) return false;
        if (!ctx) {
            const AC = win.AudioContext || win.webkitAudioContext;
            ctx = new AC();
            master = ctx.createGain();
            master.gain.value = muted ? 0 : 1;
            master.connect(ctx.destination);
            buses = {};
            for (const name of ['music', 'effects', 'ambience', 'voice']) {
                const g = ctx.createGain();
                g.gain.value = volumes[name];
                g.connect(master);
                buses[name] = g;
            }
        }
        if (ctx.state === 'suspended') ctx.resume();
        return true;
    }

    function caption(text) { if (captionCb) captionCb(text); }

    function tone(bus, freq, dur, opts) {
        if (!ensure()) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const t0 = ctx.currentTime + (opts && opts.delay || 0);
        o.type = (opts && opts.type) || 'sine';
        o.frequency.setValueAtTime(freq, t0);
        if (opts && opts.slide) o.frequency.exponentialRampToValueAtTime(opts.slide, t0 + dur);
        const peak = (opts && opts.gain) || 0.5;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(buses[bus]);
        o.start(t0); o.stop(t0 + dur + 0.02);
    }

    function noise(bus, dur, cutoff, gainVal) {
        if (!ensure()) return;
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
        const g = ctx.createGain(); g.gain.value = gainVal;
        src.connect(f); f.connect(g); g.connect(buses[bus]);
        src.start();
    }

    // ---- authored sample one-shots: lazy fetch/decode/cache after unlock ----
    const sfxMap = {};      // event -> [clip basenames]
    const sfxRR = {};       // event -> round-robin index
    const sfxCache = {};    // name -> AudioBuffer | Promise<AudioBuffer|null> | null(failed)
    let sfxManifestTried = false;

    function loadManifest() {
        if (sfxManifestTried) return;
        sfxManifestTried = true;
        if (!win || typeof win.fetch !== 'function') return;
        win.fetch('sfx/manifest.json').then(r => (r.ok ? r.json() : null)).then(list => {
            if (!Array.isArray(list)) return;
            for (const item of list) {
                if (!item || typeof item.name !== 'string' || typeof item.event !== 'string') continue;
                (sfxMap[item.event] = sfxMap[item.event] || []).push(item.name);
            }
        }).catch(() => {});
    }

    function loadSample(name) {
        if (name in sfxCache) return sfxCache[name];
        const p = win.fetch('sfx/' + name + '.opus')
            .then(r => { if (!r.ok) throw new Error('sfx missing: ' + name); return r.arrayBuffer(); })
            .then(ab => ctx.decodeAudioData(ab))
            .then(buf => { sfxCache[name] = buf; return buf; })
            .catch(() => { sfxCache[name] = null; return null; });
        sfxCache[name] = p;
        return p;
    }

    // Try to play an authored sample for this event through the given bus.
    // Returns true when a decoded clip actually played; false keeps the
    // synthesized fallback (also true while the clip is still loading).
    function trySample(kind, bus) {
        if (!ensure()) return false;
        loadManifest();
        const names = sfxMap[kind];
        if (!names || !names.length) return false;
        const name = names[(sfxRR[kind] = ((sfxRR[kind] || 0) + 1) % names.length)];
        if (sfxCache[name] === null) return false;
        const entry = loadSample(name);
        if (!entry || typeof entry.then === 'function') return false;
        const src = ctx.createBufferSource();
        src.buffer = entry;
        src.connect(buses[bus]);
        src.start();
        return true;
    }

    // ---- SFX tied to logical events (event hierarchy tiers) ----
    function playSfx(kind) {
        switch (kind) {
            case 'select':
                if (!trySample('select', 'effects')) tone('effects', 660, 0.06, { gain: 0.25 });
                caption('Vehicle selected');
                break;
            case 'move':
                if (!trySample('move', 'effects')) { noise('effects', 0.09, 900, 0.35); tone('effects', 520, 0.08, { gain: 0.2 }); }
                caption('Vehicle slid');
                break;
            case 'invalid':
                if (!trySample('invalid', 'effects')) tone('effects', 180, 0.18, { type: 'square', gain: 0.12 });
                caption('That move is blocked');
                break;
            case 'undo':
                if (!trySample('undo', 'effects')) tone('effects', 440, 0.1, { slide: 330, gain: 0.25 });
                caption('Move undone');
                break;
            case 'hint':
                if (!trySample('hint', 'effects')) { tone('effects', 880, 0.12, { gain: 0.2 }); tone('effects', 1174, 0.14, { delay: 0.09, gain: 0.2 }); }
                caption('Hint shown');
                break;
            case 'win':
                if (!trySample('win', 'effects')) [523, 659, 784, 1046].forEach((f, i) => tone('effects', f, 0.22, { delay: i * 0.11, gain: 0.3 }));
                caption('Puzzle solved');
                break;
            case 'lose':
                if (!trySample('lose', 'effects')) tone('effects', 262, 0.35, { slide: 196, gain: 0.25 });
                caption('Round over');
                break;
            case 'click':
                if (!trySample('click', 'voice')) tone('voice', 740, 0.04, { gain: 0.15 });
                break;
            case 'pause':
                if (!trySample('pause', 'voice')) tone('voice', 392, 0.12, { gain: 0.2 });
                caption('Paused');
                break;
        }
    }

    // ---- adaptive music: slow lo-fi loop, lookahead scheduler ----
    const PATTERN = [196, 247, 294, 247, 220, 262, 294, 330]; // G B D B A C D E
    function musicStep() {
        if (!ctx) return;
        const f = PATTERN[bar % PATTERN.length];
        tone('music', f, 0.9, { gain: 0.16 });
        if (bar % 2 === 0) tone('music', f / 2, 1.6, { gain: 0.12 });
        bar++;
    }
    function startMusic() {
        if (!ensure()) return;
        if (musicTimer) return;
        bar = 0;
        musicStep();
        musicTimer = setInterval(musicStep, 900);
    }
    function stopMusic() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }

    // ---- quiet ambience: filtered noise bed ----
    function startAmbience() {
        if (!ensure() || ambienceNode) return;
        const n = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
        const g = ctx.createGain(); g.gain.value = 0.25;
        src.connect(f); f.connect(g); g.connect(buses.ambience);
        src.start();
        ambienceNode = src;
    }
    function stopAmbience() { if (ambienceNode) { try { ambienceNode.stop(); } catch (e) {} ambienceNode = null; } }

    function setVolume(bus, v) {
        volumes[bus] = Math.max(0, Math.min(1, v));
        if (buses && buses[bus]) buses[bus].gain.value = volumes[bus];
    }
    function getVolumes() { return Object.assign({}, volumes); }
    function setMuted(m) { muted = !!m; if (master) master.gain.value = muted ? 0 : 1; }
    function onCaption(cb) { captionCb = cb; }
    function suspendAll() { stopMusic(); stopAmbience(); }

    return { available, playSfx, startMusic, stopMusic, startAmbience, stopAmbience, setVolume, getVolumes, setMuted, onCaption, suspendAll };
});
