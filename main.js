'use strict';

// Parkwise client: bootstrap / session / render / ui.
// Rules state is only mutated through validated commands; rendering consumes
// immutable snapshots; UI state never touches simulation state.
(function () {
    const THREE = window.THREE;
    const R = window.PARKWISE_RULES;
    const C = window.PARKWISE_CONTENT;
    const A = window.PARKWISE_AUDIO;
    const I = window.PARKWISE_I18N;
    const T = I.T, N = I.N;

    const $ = id => document.getElementById(id);

    // ================= persistence =================
    const SETTINGS_KEY = 'parkwise.settings.v1';
    const PROGRESS_KEY = 'parkwise.progress.v1';

    const defaults = {
        volumes: { music: 0.6, effects: 0.8, ambience: 0.4, voice: 0.7 },
        muted: false, theme: null,
        graphics: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
        reducedMotion: false, highContrast: false, largeText: false,
        captions: true, holdDrag: true, lefty: false,
    };
    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const doc = JSON.parse(raw);
            if (doc.v !== 1) return fallback; // versioned; migrations would go here
            if (doc.checksum !== R.hash(JSON.stringify(doc.data))) return fallback;
            return doc.data;
        } catch (e) { return fallback; }
    }
    function saveJson(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({ v: 1, checksum: R.hash(JSON.stringify(data)), data }));
        } catch (e) { /* storage unavailable: session continues without persistence */ }
    }

    // Graphics settings live in settings.graphics; the old low/medium/high tier migrates to a preset.
    function normalizeGraphics(s) {
        const legacy = { low: 'low', high: 'high' }[s.quality];
        s.graphics = Object.assign({}, defaults.graphics, !s.graphics && legacy ? { preset: legacy } : null, s.graphics);
        delete s.quality;
    }
    const settings = Object.assign({}, defaults, loadJson(SETTINGS_KEY, {}));
    settings.volumes = Object.assign({}, defaults.volumes, settings.volumes);
    normalizeGraphics(settings);
    const progress = Object.assign({
        journeyUnlocked: 0, stars: {}, wins: 0, winStreak: 0,
        tutorialsDone: [], achievements: {}, dailiesDone: {}, lastDaily: null,
        bestScores: {},
    }, loadJson(PROGRESS_KEY, {}));
    progress.bestScores = progress.bestScores || {};

    const ACHIEVEMENTS = {
        first_completion: N('First clear — solve your first lot'),
        mechanic_mastery: N('Mechanic — solve a stage without undo or hints'),
        streak_3: N('Regular — win three rounds in a row'),
        milestone_hard: N('Rooftop veteran — clear a mastery stage'),
        long_term: N('Commuter — 50 career wins'),
    };
    function unlockAchievement(key) {
        if (progress.achievements[key]) return;
        progress.achievements[key] = Date.now();
        announce(T('Achievement unlocked: {name}', { name: T(ACHIEVEMENTS[key]) }));
        A.playSfx('win');
        saveProgress();
    }
    function saveSettings() { saveJson(SETTINGS_KEY, settings); platformCloudDirty(); pushPlatformSettings(); }
    function saveProgress() { saveJson(PROGRESS_KEY, progress); platformCloudDirty(); }

    // ================= StarHermit platform (hosted mode) =================
    // window.PARKWISE_PLATFORM reads the launch token at load; hosted is true
    // only when a token was actually read. Local/offline play never calls the API.
    const PF = window.PARKWISE_PLATFORM;
    const platform = { hosted: !!(PF && PF.hosted), nickname: null, avatar: null, sync: 'local' };
    // the platform has no time or score routes: those dev-server calls stay off *.starhermit.com
    const onPlatformHost = /(^|\.)starhermit\.com$/.test(location.hostname);

    function platformCloudDirty() { if (PF) PF.cloudDirty(); }

    // Player preferences mirrored to the StarHermit settings KV (the account value wins at boot).
    const KV_KEYS = ['volumes', 'muted', 'theme', 'graphics', 'reducedMotion', 'highContrast', 'largeText', 'captions', 'holdDrag', 'lefty'];
    let kvSig = null;
    function kvSnapshot() { return Object.fromEntries(KV_KEYS.map(k => [k, settings[k] === undefined ? null : settings[k]])); }
    function pushPlatformSettings() {
        if (!platform.hosted) return;
        const o = kvSnapshot(), sig = JSON.stringify(o);
        if (sig === kvSig) return;
        kvSig = sig;
        PF.patchSettings(o);
    }

    // Keyboard actions by KeyboardEvent.code, mirrored as control.* lines in
    // starhermit.txt; the player's StarHermit rebinds replace these at boot.
    const KEY_DEFAULTS = {
        left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
        undo: ['KeyU'], hint: ['KeyH'], restart: ['KeyR'], camera: ['KeyC'], pause: ['KeyP'], menu: ['Escape'],
    };
    let keys = JSON.parse(JSON.stringify(KEY_DEFAULTS));
    const keyAction = code => Object.keys(keys).find(a => keys[a].includes(code)) || null;
    function keyLabel(code) {
        const named = { Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space' };
        return named[code] || String(code || '').replace(/^Key/, '').replace(/^Digit/, '');
    }
    // How to play → Controls lists the effective keys.
    function renderKeyHelp() {
        const el = $('help-keys');
        if (!el) return;
        const k = a => keys[a].map(keyLabel).join('/');
        el.textContent = T('{arrows} slide, {undo} undo, {hint} hint, {restart} restart, {camera} reset camera, {pause} pause.', {
            arrows: [k('left'), k('right'), k('up'), k('down')].join(' '), undo: k('undo'), hint: k('hint'),
            restart: k('restart'), camera: k('camera'), pause: k('pause') + '/' + k('menu'),
        });
    }

    // Title account buttons: sign-in only where the platform offers it, invite only when signed in.
    function refreshAccount() {
        $('btn-sh-signin').style.display = PF && PF.canSignIn() ? '' : 'none';
        $('btn-sh-invite').style.display = PF && PF.inviteLink() ? '' : 'none';
    }
    let toastTimer = null;
    function toast(msg) {
        const el = $('sh-toast');
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
    }

    function boardKey(mode, entry) { return mode + ':' + (entry.day || entry.seed); }

    function renderProfileLine() {
        const el = $('profile-line');
        if (!platform.hosted) {
            el.textContent = T('Local profile — progress is saved on this device.');
            return;
        }
        const syncText = T({
            saving: N('saving to your account…'),
            synced: N('progress synced to your account'),
            offline: N('offline — changes stay on this device'),
        }[platform.sync] || N('progress follows this account'));
        el.textContent = (platform.nickname || T('Player')) + ' — ' + syncText;
        if (platform.avatar) {
            const img = document.createElement('img');
            img.className = 'avatar'; img.src = platform.avatar; img.alt = ''; img.width = 20; img.height = 20;
            el.prepend(img);
        }
    }

    // A cloud doc never simply replaces this device's progress: PF.mergeProgress
    // keeps the better result of each record (launch load and saveconflict).
    // Settings follow the account; localStorage stays the offline cache.
    function applyRemoteDoc(doc) {
        if (!doc || typeof doc !== 'object') return false;
        if (doc.settings && typeof doc.settings === 'object') {
            Object.assign(settings, defaults, doc.settings);
            settings.volumes = Object.assign({}, defaults.volumes, settings.volumes);
            normalizeGraphics(settings);
        }
        if (doc.progress && typeof doc.progress === 'object') {
            const merged = PF.mergeProgress(doc.progress, progress);
            for (const k of Object.keys(progress)) delete progress[k];
            Object.assign(progress, merged);
            progress.bestScores = progress.bestScores || {};
        }
        saveJson(SETTINGS_KEY, settings); // refresh the cache without re-uploading
        saveJson(PROGRESS_KEY, progress);
        applySettingsToDom();
        themeSel.value = settings.theme || C.THEMES[0].id;
        render.setGraphics(settings.graphics);
        syncGraphicsUi();
        return true;
    }

    async function initPlatform() {
        if (PF) {
            keys = await PF.loadBindings(KEY_DEFAULTS);
            PF.onAuth(a => {
                platform.hosted = a.signedIn;
                if (!a.signedIn) { platform.avatar = null; toast(GFX_S.sh.signedOut); }
                renderProfileLine();
                refreshAccount();
            });
        }
        if (!platform.hosted) return;
        platform.nickname = PF.fallbackName(PF.sub);
        PF.onStatus(s => { platform.sync = s; renderProfileLine(); });
        // The cloud mirror is armed only once the load settles: armed earlier,
        // a pagehide/hidden flush or a save after the 5 s boot timeout would
        // PUT the stale local cache over a newer cloud save mid-load.
        const cloudDoc = () => ({ savedAt: Date.now(), settings, progress });
        try {
            const remote = await PF.cloudLoad();
            PF.cloudStart(cloudDoc);
            if (remote) {
                const before = JSON.stringify(remote.progress || null);
                applyRemoteDoc(remote); // merged with the local progress
                if (JSON.stringify(progress) !== before) PF.cloudDirty(); // write the merge back
            } else PF.cloudDirty(); // no remote save yet: mirror the local cache up once
        } catch (e) { PF.cloudStart(cloudDoc); /* offline start: the local cache stays authoritative */ }
        // Another device saved first: the SDK refused our write; re-read, merge, save again.
        PF.onSaveConflict(async () => {
            const remote = await PF.cloudLoad().catch(() => null);
            if (remote) applyRemoteDoc(remote);
            PF.cloudDirty();
        });
        // the account's preferences (settings KV) win over the local copy
        try {
            const kv = await PF.getSettings();
            const picked = {};
            for (const k of KV_KEYS) if (kv && kv[k] !== undefined && kv[k] !== null) picked[k] = kv[k];
            if (Object.keys(picked).length) applyRemoteDoc({ settings: Object.assign({}, settings, picked) });
            kvSig = JSON.stringify(kvSnapshot());
        } catch (e) { /* settings KV unreachable: local settings stay */ }
        PF.myDisplayName().then(n => { platform.nickname = n; renderProfileLine(); });
        PF.avatarUrl().then(u => { if (u) { platform.avatar = u; renderProfileLine(); } });
        renderProfileLine();
    }

    // ================= app state machine =================
    // boot → title → mode-select → preparing → active ↔ paused → results
    let appState = 'boot';
    function setAppState(next, reason) {
        appState = next;
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        if (next === 'title') $('screen-title').classList.add('active');
        else if (next === 'mode-select') $('screen-modes').classList.add('active');
        else if (next === 'preparing') $('screen-setup').classList.add('active');
        else if (['active', 'paused', 'resolving', 'results'].includes(next)) $('screen-game').classList.add('active');
        if (reason) announce(reason);
    }

    // ================= accessibility helpers =================
    let lastAnnounce = '';
    function announce(text) {
        if (text === lastAnnounce) return;
        lastAnnounce = text;
        $('sr-announcer').textContent = text;
    }
    let captionTimer = null, captionKey = null;
    // Audio captions arrive in English (audio.js); show them in the game language.
    const CAPTIONS = [N('Vehicle selected'), N('Vehicle slid'), N('That move is blocked'), N('Move undone'), N('Hint shown'), N('Puzzle solved'), N('Round over'), N('Paused')];
    A.onCaption(text => {
        if (!settings.captions) return;
        const el = $('caption-line');
        captionKey = text;
        el.textContent = T(text);
        el.classList.add('show');
        clearTimeout(captionTimer);
        captionTimer = setTimeout(() => el.classList.remove('show'), 1800);
    });

    function applySettingsToDom() {
        document.body.classList.toggle('reduced-motion', settings.reducedMotion);
        document.body.classList.toggle('high-contrast', settings.highContrast);
        document.body.classList.toggle('large-text', settings.largeText);
        $('tray').style.flexDirection = settings.lefty ? 'row-reverse' : 'row';
        for (const bus of ['music', 'effects', 'ambience', 'voice']) {
            $('vol-' + bus).value = Math.round(settings.volumes[bus] * 100);
            A.setVolume(bus, settings.volumes[bus]);
        }
        $('opt-mute').checked = settings.muted;
        $('opt-reduced-motion').checked = settings.reducedMotion;
        $('opt-high-contrast').checked = settings.highContrast;
        $('opt-large-text').checked = settings.largeText;
        $('opt-captions').checked = settings.captions;
        $('opt-hold-drag').checked = settings.holdDrag;
        $('opt-lefty').checked = settings.lefty;
        A.setMuted(settings.muted);
    }

    // ================= session =================
    let session = null;
    let cmdCounter = 0;

    function newSession(mode, entry) {
        session = {
            mode, entry,
            state: R.makeState(entry.level),
            history: [], commands: [], stateHashes: [],
            hintsUsed: 0, hintShown: null, invalidCount: 0, undosUsed: 0,
            activeMs: 0, lastTick: null, over: false, won: false,
            selected: R.targetVehicle(R.makeState(entry.level)),
            practiceAttempt: session && session.mode === 'practice' ? session.practiceAttempt : 0,
        };
        session.stateHashes.push(R.stateHash(session.state));
        cmdCounter = 0;
        render.buildBoard(entry);
        ui.refreshAll();
    }

    function sessionElapsedSec() { return Math.floor(session.activeMs / 1000); }

    // All rule mutations pass through here (validated command, idempotent id).
    function executeMove(vIdx, dir, dist, actionId) {
        if (!session || session.over || appState === 'paused') return false;
        if (actionId && actionId === session.lastActionId) return false; // double-commit guard
        session.lastActionId = actionId || ('c' + (++cmdCounter));
        const reason = R.illegalReason(session.state, vIdx, dir, dist);
        if (reason) {
            session.invalidCount++;
            A.playSfx('invalid');
            announce(T('Cannot move: {reason}.', { reason: T(reason) }));
            render.flashInvalid(vIdx);
            ui.refreshHud();
            return false;
        }
        session.history.push(session.state);
        session.state = R.applyMove(session.state, vIdx, dir, dist);
        session.commands.push({ type: 'move', v: vIdx, dir, dist });
        session.stateHashes.push(R.stateHash(session.state));
        session.hintShown = null;
        A.playSfx('move');
        const won = R.isWin(session.state);
        if (won) return endRound(true);
        const lim = session.entry.challenge;
        if (lim && lim.moveLimit && session.state.moves > lim.moveLimit) return endRound(false, N('Move limit reached'));
        render.syncVehicles(true);
        ui.refreshAll();
        return true;
    }

    function undoMove() {
        if (!session || !session.history.length || session.over) { A.playSfx('invalid'); return false; }
        session.state = session.history.pop();
        session.commands.pop();
        session.stateHashes.pop();
        session.undosUsed++;
        A.playSfx('undo');
        render.syncVehicles(true);
        ui.refreshAll();
        return true;
    }

    function requestHint() {
        if (!session || session.over) return;
        if (session.entry.challenge && session.entry.challenge.noHint) {
            announce(T('Hints are disabled in this challenge.'));
            A.playSfx('invalid');
            return;
        }
        const sol = R.solve(session.state);
        if (!sol || !sol.firstMove) { announce(T('No hint available.')); return; }
        session.hintsUsed++;
        session.hintShown = sol.firstMove;
        const v = session.state.vehicles[sol.firstMove.v];
        A.playSfx('hint');
        const way = sol.firstMove.dir > 0 ? (v.ori === 'h' ? N('right') : N('down')) : (v.ori === 'h' ? N('left') : N('up'));
        announce(T('Hint: try moving the {vehicle} {dir}.', { vehicle: vehicleName(v), dir: T(way) }));
        render.highlightHint(sol.firstMove);
        ui.refreshHud();
    }

    function endRound(won, loseReason) {
        session.over = true;
        session.won = won;
        setAppState('resolving', won ? T('Solved!') : T('Round over'));
        const secs = sessionElapsedSec();
        const sc = R.score({
            par: session.entry.par, moves: session.state.moves, seconds: secs,
            hints: session.hintsUsed, invalid: session.invalidCount,
            won, challenge: !!(session.entry.challenge),
        });
        session.finalScore = sc;
        if (won) {
            A.playSfx('win');
            const bk = boardKey(session.mode, session.entry);
            if (!progress.bestScores[bk] || sc.total > progress.bestScores[bk]) progress.bestScores[bk] = sc.total;
            progress.wins++;
            progress.winStreak++;
            if (session.hintsUsed === 0 && session.undosUsed === 0 && session.state.moves <= session.entry.par && session.invalidCount === 0) unlockAchievement('mechanic_mastery');
            unlockAchievement('first_completion');
            if (progress.winStreak >= 3) unlockAchievement('streak_3');
            if (progress.wins >= 50) unlockAchievement('long_term');
            if (session.mode === 'journey') {
                const idx = parseInt(session.entry.id.split('-')[1], 10) - 1;
                progress.journeyUnlocked = Math.max(progress.journeyUnlocked, Math.min(C.JOURNEY_COUNT - 1, idx + 1));
                const stars = sc.total >= R.score({ par: session.entry.par, moves: session.entry.par, seconds: 30, hints: 0, invalid: 0, won: true }).total * 0.9 ? 3 : sc.total > 700 ? 2 : 1;
                progress.stars[session.entry.id] = Math.max(progress.stars[session.entry.id] || 0, stars);
                if (session.entry.mastery) unlockAchievement('milestone_hard');
            }
            if (session.mode === 'daily') { progress.dailiesDone[session.entry.day] = sc.total; progress.lastDaily = session.entry.day; }
            saveProgress();
        } else {
            A.playSfx('lose');
            progress.winStreak = 0;
            saveProgress();
        }
        const finishedSession = session;
        setTimeout(() => {
            if (session === finishedSession && appState === 'resolving') showResults(won, sc, loseReason);
        }, settings.reducedMotion ? 200 : 900);
        return true;
    }

    // ================= renderer (Three.js rooftop diorama) =================
    const CELL = 1.6;
    const G = window.PARKWISE_GFX;
    const render = (function () {
        const canvas = $('game-canvas');
        let renderer = null;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        } catch (e) {
            $('compat-message').style.display = 'block';
            $('compat-message').textContent = T('WebGL is unavailable. Parkwise needs 3D graphics; your progress is safe on this device.');
            // headless stub with the same surface as the renderer below
            return {
                buildBoard() {}, syncVehicles() {}, flashInvalid() {}, select() {},
                highlightHint(move) { if (session) session.selected = move.v; },
                applyQuality() {}, setGraphics() {}, graphicsInfo() { return null; }, onInfo() {},
                applyTheme() {}, resetCamera() {}, resize() {}, frame() {},
                celebrate() {}, pickCell() { return null; }, pickVehicle() { return -1; }, screenPos() { return null; },
                pickMarker() { return null; }, dispose() {},
            };
        }
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.type = THREE.PCFShadowMap;

        // ---- GPU detection → hardware level → Auto preset
        const gl = renderer.getContext();
        let gpu = '';
        try {
            gpu = String(gl.getParameter(gl.RENDERER) || '');
            if (!gpu || /^webkit/i.test(gpu)) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || gpu);
            }
        } catch (e) { /* renderer string masked */ }
        const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
        const mobile = coarse || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
        // StarHermit hardware level (gpu-level.js): renderer string + device facts (phone/tablet, cores,
        // memory, screen).
        let sys = { mobile, webgl2: renderer.capabilities.isWebGL2 };
        try {
            const SG = window.StarHermitGpu;
            if (SG) { const d = SG.detectSystem(); sys = { mobile: mobile || d.mobile, webgl2: sys.webgl2, touch: d.touch, screen: d.screen, cores: d.cores, memoryGb: d.memoryGb, astc: d.astc }; }
        } catch (e) { /* defaults */ }
        const gpuLevel = G.detectLevel(gpu, sys);
        const detected = G.presetForLevel(gpuLevel);
        let q = G.resolve(settings.graphics, detected, gpuLevel);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
        const CAM_HOME = { pos: new THREE.Vector3(0, 11.5, 10.5), look: new THREE.Vector3(0, 0, 0.4) };
        // Pull back along the home direction until the whole lot fits the current
        // aspect — narrow portrait screens otherwise cut off the outer columns.
        function fitCamera() {
            const dir = CAM_HOME.pos.clone().sub(CAM_HOME.look);
            const home = dir.length();
            dir.normalize();
            const tanV = Math.tan((camera.fov * Math.PI / 180) / 2);
            const tanH = tanV * Math.max(0.05, camera.aspect);
            const halfW = (R.GRID * CELL) / 2 + 1.4;                 // lot width + parapet
            const halfV = ((R.GRID * CELL) / 2) * (CAM_HOME.pos.y / home) + 1.0; // depth foreshortened by the tilt
            const need = Math.max(halfW / tanH, halfV / tanV);
            const dist = Math.max(home, need);
            camera.position.copy(CAM_HOME.look).addScaledVector(dir, dist);
            camera.lookAt(CAM_HOME.look);
            // fog starts behind the lot at any camera distance, so the board never hazes
            if (scene.fog) { scene.fog.near = dist + 8; scene.fog.far = dist + 46; }
        }
        function resetCamera() { fitCamera(); }
        resetCamera();

        const hemi = new THREE.HemisphereLight(0xffffff, 0x333344, 0.85);
        scene.add(hemi);
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(8, 14, 6);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        // shadow frustum fitted to the rooftop slab + props (half extent ≈ 7.6)
        const sc = 8;
        Object.assign(key.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc, near: 4, far: 34 });
        key.shadow.camera.updateProjectionMatrix();
        key.shadow.bias = -0.0004;
        key.shadow.normalBias = 0.02;
        key.shadow.radius = 3;
        scene.add(key);

        // layers: 0 env, 1 gameplay, 2 markers/ghosts
        const LAYER_GAME = 1, LAYER_MARK = 2;
        camera.layers.enable(LAYER_GAME);
        camera.layers.enable(LAYER_MARK);

        let boardGroup = null;
        let vehicleViews = [];
        let markerMeshes = [];
        let selectRing = null;
        let exitGate = null;
        let theme = C.THEMES[0];
        let vfx = []; // pooled celebration particles
        let confettiMats = [];
        let ambient = null; // detailed-scene animated bits: chevrons, beacon, dust
        let builtWith = null; // detail|particles the current board was built with
        const avRng = R.rng(1234); // audiovisual variant stream (never rules)

        // ---- post-processing + image-based lighting (lazy module, same three.js revision)
        let POST = null, postLoadFailed = false, postFailed = false;
        let composer = null, postKey = null, envTex = null;
        let infoListener = null;
        import('./post.js').then(m => { POST = m; applyEnv(); postKey = null; if (infoListener) infoListener(); })
            .catch(() => { postLoadFailed = true; if (infoListener) infoListener(); });

        function cellToWorld(x, y) {
            return { x: (x - (R.GRID - 1) / 2) * CELL, z: (y - (R.GRID - 1) / 2) * CELL };
        }

        function disposeGroup(g) {
            if (!g) return;
            g.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
            });
            scene.remove(g);
        }

        // ---- shared procedural textures (built once, never disposed with the board)
        // `px` (the preset's texture budget) draws the authored size-pixel texture into px × px.
        const texCache = {};
        function canvasTexture(name, size, draw, repeat, px) {
            const key = name + (px ? '@' + px : '');
            if (texCache[key]) return texCache[key];
            const cv = document.createElement('canvas');
            cv.width = px || size[0]; cv.height = px ? Math.round(px * size[1] / size[0]) : size[1];
            const ctx = cv.getContext('2d');
            ctx.scale(cv.width / size[0], cv.height / size[1]);
            draw(ctx, size[0], size[1], R.rng(0x5EED + name.length * 97));
            const t = new THREE.CanvasTexture(cv);
            t.colorSpace = THREE.SRGBColorSpace;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            if (repeat) t.repeat.set(repeat, repeat);
            t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            texCache[key] = t;
            return t;
        }
        // near-white grain so the theme colour still reads as the surface colour
        function speckle(ctx, w, h, rnd, base, dots, blotches) {
            ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < blotches; i++) {
                const x = rnd() * w, y = rnd() * h, r = 12 + rnd() * 40;
                const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, `rgba(0,0,0,${0.04 + rnd() * 0.06})`); g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
            }
            for (let i = 0; i < dots; i++) {
                const v = 150 + Math.floor(rnd() * 105);
                ctx.fillStyle = `rgba(${v},${v},${v},0.55)`;
                ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
            }
        }
        const asphaltTex = () => canvasTexture('asphalt', [256, 256], (c, w, h, r) => speckle(c, w, h, r, '#f0f0f0', 5200, 26), 3, q.budget.texture);
        const concreteTex = () => canvasTexture('concrete', [256, 256], (c, w, h, r) => {
            speckle(c, w, h, r, '#f4f4f4', 1800, 40);
            c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 2;
            for (let p = 0; p <= w; p += 64) { c.beginPath(); c.moveTo(p, 0); c.lineTo(p, h); c.moveTo(0, p); c.lineTo(w, p); c.stroke(); }
        }, 2, q.budget.texture);
        const windowTex = () => canvasTexture('windows', [64, 128], (c, w, h, r) => {
            c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
            for (let y = 6; y < h - 6; y += 10) for (let x = 5; x < w - 5; x += 9) {
                if (r() < 0.42) { const v = 170 + Math.floor(r() * 85); c.fillStyle = `rgb(${v},${Math.floor(v * 0.86)},${Math.floor(v * 0.6)})`; c.fillRect(x, y, 5, 6); }
            }
        });

        // Rounded slab: rounded rectangle footprint (sx × sz) extruded to height h with bevelled edges; base at y = 0.
        function roundedSlab(sx, sz, h, r, bevel) {
            const hx = sx / 2 - bevel, hz = sz / 2 - bevel;
            r = Math.max(0.01, Math.min(r, hx - 0.01, hz - 0.01));
            const s = new THREE.Shape();
            s.moveTo(-hx + r, -hz); s.lineTo(hx - r, -hz); s.quadraticCurveTo(hx, -hz, hx, -hz + r);
            s.lineTo(hx, hz - r); s.quadraticCurveTo(hx, hz, hx - r, hz);
            s.lineTo(-hx + r, hz); s.quadraticCurveTo(-hx, hz, -hx, hz - r);
            s.lineTo(-hx, -hz + r); s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
            const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.01, h - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: q.budget.bevel, curveSegments: q.budget.curve });
            g.rotateX(-Math.PI / 2);
            g.translate(0, bevel, 0);
            return g;
        }

        // Lit materials per the preset's budget: Lambert on Low (emissive kept), Standard on Balanced,
        // and Physical (clear-coated paint and glass) only on High/Ultra. Shared ones are cached per board
        // build, so every vehicle reuses the same glass, tyre, light and stripe materials.
        function lit(params, physical) {
            const tier = q.budget.material;
            if (tier === 'lambert') {
                const keep = {};
                for (const k of ['color', 'emissive', 'emissiveIntensity', 'emissiveMap', 'map', 'side', 'transparent', 'opacity']) if (params[k] !== undefined) keep[k] = params[k];
                return new THREE.MeshLambertMaterial(keep);
            }
            if (physical && tier === 'physical') return new THREE.MeshPhysicalMaterial(params);
            const { clearcoat, clearcoatRoughness, ...rest } = params;
            return new THREE.MeshStandardMaterial(rest);
        }
        let sharedMats = null;
        function shared(name, make) {
            sharedMats = sharedMats || {};
            return sharedMats[name] || (sharedMats[name] = make());
        }

        function makeVehicleMesh(v, isTarget, colorHex) {
            if (q.detail === 'detailed') return makeDetailedVehicle(v, isTarget, colorHex);
            const grp = new THREE.Group();
            const L = v.len * CELL * 0.92, W = CELL * 0.72, H = 0.5;
            const mat = lit({ color: colorHex, roughness: 0.45, metalness: 0.25 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(v.ori === 'h' ? L : W, H, v.ori === 'h' ? W : L), mat);
            body.position.y = H / 2 + 0.12;
            body.castShadow = true;
            grp.add(body);
            const cabMat = shared('cab', () => lit({ color: 0x223044, roughness: 0.2, metalness: 0.4 }));
            const cab = new THREE.Mesh(new THREE.BoxGeometry(v.ori === 'h' ? L * 0.42 : W * 0.8, 0.32, v.ori === 'h' ? W * 0.8 : L * 0.42), cabMat);
            cab.position.y = H + 0.28;
            grp.add(cab);
            const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 10);
            const wheelMat = shared('wheel', () => lit({ color: 0x15181d, roughness: 0.9 }));
            const offs = v.ori === 'h' ? [[-L / 2 + 0.35, -W / 2], [L / 2 - 0.35, -W / 2], [-L / 2 + 0.35, W / 2], [L / 2 - 0.35, W / 2]]
                : [[-W / 2, -L / 2 + 0.35], [W / 2, -L / 2 + 0.35], [-W / 2, L / 2 - 0.35], [W / 2, L / 2 - 0.35]];
            for (const [ox, oz] of offs) {
                const w = new THREE.Mesh(wheelGeo, wheelMat);
                w.rotation.z = Math.PI / 2;
                w.rotation.y = v.ori === 'v' ? Math.PI / 2 : 0;
                w.position.set(ox, 0.16, oz);
                grp.add(w);
            }
            if (isTarget) {
                const glowMat = lit({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.35, roughness: 0.4 });
                body.material = glowMat;
            }
            grp.layers.set(LAYER_GAME);
            grp.traverse(o => o.layers.set(LAYER_GAME));
            return grp;
        }

        // Detailed vehicle: rounded clear-coated body, glass cabin, axles, light bars.
        // Built along +x (front = +x), then turned for upright vehicles.
        function makeDetailedVehicle(v, isTarget, colorHex) {
            const grp = new THREE.Group();
            const car = new THREE.Group();
            if (v.ori === 'v') car.rotation.y = -Math.PI / 2;
            grp.add(car);
            const L = v.len * CELL * 0.92, W = CELL * 0.72, CL = 0.13;
            const paint = lit({
                color: colorHex, roughness: 0.4, metalness: 0.15, clearcoat: 0.7, clearcoatRoughness: 0.1,
                emissive: isTarget ? colorHex : 0x000000, emissiveIntensity: isTarget ? 0.22 : 0,
            }, true);
            const glass = shared('glass', () => lit({ color: 0x16202c, roughness: 0.06, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 }, true));
            const rubber = shared('rubber', () => lit({ color: 0x14171b, roughness: 0.85 }));
            const head = shared('head', () => lit({ color: 0xfff4dc, emissive: 0xfff1d0, emissiveIntensity: 1.5 }));
            const tail = shared('tail', () => lit({ color: 0xff3b30, emissive: 0xff2a1a, emissiveIntensity: 1.8 }));
            const add = (geo, mat, x, y, z, cast) => {
                const m = new THREE.Mesh(geo, mat);
                m.position.set(x, y, z);
                m.castShadow = !!cast;
                car.add(m);
                return m;
            };
            let bodyTop;
            if (v.len >= 3) {
                // box van: tall cargo body at the back, lower cab with windscreen at the front
                add(roundedSlab(L * 0.7, W, 0.8, 0.16, 0.06), paint, -L * 0.15, CL, 0, true);
                add(roundedSlab(L * 0.31, W * 0.96, 0.46, 0.24, 0.08), paint, L * 0.345, CL, 0, true);
                add(roundedSlab(L * 0.17, W * 0.86, 0.24, 0.1, 0.05), glass, L * 0.3, CL + 0.42, 0, true);
                bodyTop = CL + 0.8;
            } else {
                add(roundedSlab(L, W, 0.42, 0.3, 0.08), paint, 0, CL, 0, true);
                add(roundedSlab(L * 0.52, W * 0.84, 0.3, 0.22, 0.06), glass, -L * 0.05, CL + 0.38, 0, true);
                add(roundedSlab(L * 0.42, W * 0.78, 0.05, 0.18, 0.02), paint, -L * 0.06, CL + 0.67, 0, false);
                bodyTop = CL + 0.42;
            }
            // axles: one cylinder per axle, tyres peek out at both sides
            const axle = shared('axle', () => new THREE.CylinderGeometry(0.17, 0.17, W * 0.98, 16).rotateX(Math.PI / 2));
            add(axle, rubber, L / 2 - 0.42, 0.17, 0, true);
            add(axle, rubber, -L / 2 + 0.42, 0.17, 0, true);
            // light bars: warm head lights at the front, red tail lights at the back (bloom sources)
            const bar = shared('bar', () => new THREE.BoxGeometry(0.05, 0.07, W * 0.72));
            add(bar, head, L / 2 - 0.01, CL + 0.26, 0);
            add(bar, tail, -L / 2 + 0.01, CL + 0.3, 0);
            if (isTarget) {
                // white racing stripe: the target reads by shape, not colour alone
                const stripeMat = shared('stripe', () => lit({ color: 0xffffff, roughness: 0.4 }));
                add(new THREE.BoxGeometry(L * 0.9, 0.012, 0.16), stripeMat, 0, bodyTop + 0.004, 0);
                if (v.len < 3) add(new THREE.BoxGeometry(L * 0.4, 0.012, 0.16), stripeMat, -L * 0.06, CL + 0.724, 0);
            }
            grp.layers.set(LAYER_GAME);
            grp.traverse(o => o.layers.set(LAYER_GAME));
            return grp;
        }

        // Distant city blocks under the rooftop (one instanced draw), fogged into the sky.
        function buildSkyline(group) {
            const rnd = R.rng(0xC17E);
            const N = q.budget.skyline;
            const facade = lit({
                color: new THREE.Color(theme.fog).lerp(new THREE.Color(0x2a3444), 0.55), roughness: 0.9,
                emissive: 0xffe2b0, emissiveMap: windowTex(),
                emissiveIntensity: theme.id === 'night' ? 1.3 : theme.id === 'dusk' || theme.id === 'contrast' ? 0.6 : 0.12,
            });
            const roof = lit({ color: new THREE.Color(theme.fog).multiplyScalar(0.42), roughness: 0.95 });
            const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), [facade, facade, roof, roof, facade, facade], N);
            const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), qq = new THREE.Quaternion();
            for (let i = 0; i < N; i++) {
                const a = (i / N) * Math.PI * 2 + rnd() * 0.12;
                const r = 16 + rnd() * 20;
                const top = -15 + rnd() * 11, bottom = -48;
                s.set(2.4 + rnd() * 3.5, top - bottom, 2.4 + rnd() * 3.5);
                p.set(Math.cos(a) * r, (top + bottom) / 2, Math.sin(a) * r);
                qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 0.5);
                mesh.setMatrixAt(i, m.compose(p, qq, s));
            }
            group.add(mesh);
        }

        function buildDetailedProps(group, half, size, exZ) {
            const deco = R.rng((session ? session.entry.seed : 1) ^ 0xDEC0);
            const metal = lit({ color: 0x7b8594, roughness: 0.45, metalness: 0.6 });
            const dark = lit({ color: 0x2a3038, roughness: 0.6, metalness: 0.4 });
            const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; group.add(m); return m; };
            // seeded rooftop props: AC units with fan grilles and round vents
            for (let i = 0; i < 7; i++) {
                const pw = 0.5 + deco() * 0.6, ph = 0.3 + deco() * 0.7, pd = 0.5 + deco() * 0.6;
                const side = Math.floor(deco() * 4);
                const off = half + 1.2 + deco() * 0.8;
                const along = (deco() - 0.5) * (size + 2);
                const x = side <= 1 ? along : side === 2 ? -off : off;
                const z = side === 0 ? -off : side === 1 ? off : along;
                if (deco() < 0.6) {
                    add(roundedSlab(pw, pd, ph, 0.06, 0.03), metal, x, 0, z);
                    add(new THREE.CylinderGeometry(Math.min(pw, pd) * 0.34, Math.min(pw, pd) * 0.34, 0.03, 18), dark, x, ph + 0.01, z);
                } else {
                    add(new THREE.CylinderGeometry(0.16, 0.2, ph + 0.3, 14), metal, x, (ph + 0.3) / 2, z);
                    add(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 14), metal, x, ph + 0.33, z);
                }
            }
            // lamp posts at two corners (warm heads bloom at dusk/night)
            const lampMat = lit({ color: 0xfff3d6, emissive: 0xffe0a8, emissiveIntensity: 2.6 });
            for (const [lx, lz] of [[-half - 1.5, -half - 1.5], [half + 1.5, half + 1.5]]) {
                add(new THREE.CylinderGeometry(0.05, 0.07, 2.4, 10), dark, lx, 1.2, lz);
                add(new THREE.BoxGeometry(0.5, 0.08, 0.22), lampMat, lx + (lx < 0 ? 0.2 : -0.2), 2.42, lz);
            }
            // antenna mast with a blinking beacon
            add(new THREE.CylinderGeometry(0.03, 0.05, 3.1, 8), metal, half + 1.6, 1.55, -half - 1.6);
            const beaconMat = lit({ color: 0xff4040, emissive: 0xff2020, emissiveIntensity: 3 });
            const beacon = add(new THREE.SphereGeometry(0.08, 12, 8), beaconMat, half + 1.6, 3.15, -half - 1.6);
            beacon.castShadow = false;
            // exit gate: bollards and animated chevrons pointing out of the lot
            const bollard = lit({ color: 0xffc107, roughness: 0.5 });
            add(new THREE.CylinderGeometry(0.09, 0.09, 0.55, 12), bollard, half + 0.55, 0.28, exZ - CELL * 0.52);
            add(new THREE.CylinderGeometry(0.09, 0.09, 0.55, 12), bollard, half + 0.55, 0.28, exZ + CELL * 0.52);
            const chev = new THREE.Shape();
            chev.moveTo(-0.12, -0.34); chev.lineTo(0.02, -0.34); chev.lineTo(0.2, 0); chev.lineTo(0.02, 0.34); chev.lineTo(-0.12, 0.34); chev.lineTo(0.06, 0);
            const chevGeo = new THREE.ShapeGeometry(chev);
            chevGeo.rotateX(-Math.PI / 2);
            const chevrons = [];
            for (let i = 0; i < 3; i++) {
                const mat = lit({ color: 0x9dffd0, emissive: 0x3dffa0, emissiveIntensity: 1.2 });
                const m = new THREE.Mesh(chevGeo, mat);
                m.position.set(half + 0.45 + i * 0.36, 0.125, exZ);
                group.add(m);
                chevrons.push(m);
            }
            // drifting dust motes (cosmetic, environment layer, never picked)
            let dust = null;
            if (q.particles === 'high') {
                const n = q.budget.dust, pos = new Float32Array(n * 3), prnd = R.rng(0xD057);
                for (let i = 0; i < n; i++) { pos[i * 3] = (prnd() - 0.5) * 15; pos[i * 3 + 1] = 0.3 + prnd() * 4; pos[i * 3 + 2] = (prnd() - 0.5) * 15; }
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                dust = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xfff6e0, size: 0.06, transparent: true, opacity: 0.6, depthWrite: false }));
                group.add(dust);
            }
            return { chevrons, beacon, dust };
        }

        function buildBoard(entry) {
            disposeGroup(boardGroup);
            for (const p of vfx) p.m.geometry.dispose();
            for (const m of confettiMats) m.dispose();
            confettiMats = [];
            vfx = [];
            vehicleViews = [];
            markerMeshes = [];
            ambient = null;
            builtWith = boardKey();
            sharedMats = null; // the previous board's shared materials were disposed with its group
            const detailed = q.detail === 'detailed';
            boardGroup = new THREE.Group();
            scene.add(boardGroup);
            theme = C.THEMES.find(t => t.id === (settings.theme || entry.theme)) || C.THEMES[0];
            scene.background = new THREE.Color(theme.sky);
            scene.fog = new THREE.Fog(theme.fog, 24, 60);
            hemi.color.set(detailed ? theme.fog : 0xffffff);
            key.color.set(theme.key);
            fitCamera();

            const size = R.GRID * CELL;
            // rooftop slab
            const slab = new THREE.Mesh(new THREE.BoxGeometry(size + 4.4, 0.8, size + 4.4),
                lit({ color: theme.slab, roughness: 0.95, map: detailed ? concreteTex() : null }));
            slab.position.y = -0.4;
            slab.receiveShadow = true;
            boardGroup.add(slab);
            // parking surface
            const lot = new THREE.Mesh(new THREE.BoxGeometry(size + 0.5, 0.1, size + 0.5),
                lit({ color: theme.ground, roughness: 0.9, map: detailed ? asphaltTex() : null }));
            lot.position.y = 0.001;
            lot.receiveShadow = true;
            boardGroup.add(lot);
            // grid lines + cell markers (readable without effects); kept just under the bloom threshold
            const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.line).multiplyScalar(0.9) });
            for (let i = 0; i <= R.GRID; i++) {
                const p = (i - R.GRID / 2) * CELL;
                const h = new THREE.Mesh(new THREE.BoxGeometry(size, 0.02, 0.045), lineMat);
                h.position.set(0, 0.06, p);
                const vl = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, size), lineMat);
                vl.position.set(p, 0.06, 0);
                boardGroup.add(h); boardGroup.add(vl);
            }
            // parapet walls with a gap at the exit
            const wallMat = lit({ color: theme.parapet, roughness: 0.85, map: detailed ? concreteTex() : null });
            const capMat = lit({ color: new THREE.Color(theme.parapet).offsetHSL(0, -0.05, 0.14), roughness: 0.7 });
            const exZ = cellToWorld(0, R.EXIT_ROW).z;
            const mkWall = (w, d, x, z) => {
                const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), wallMat);
                m.position.set(x, 0.35, z);
                m.castShadow = true;
                m.receiveShadow = detailed;
                boardGroup.add(m);
                if (detailed) {
                    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.07, d + 0.08), capMat);
                    cap.position.set(x, 0.735, z);
                    cap.castShadow = true;
                    boardGroup.add(cap);
                }
            };
            const half = size / 2;
            mkWall(size + 1, 0.35, 0, -half - 0.35);
            mkWall(size + 1, 0.35, 0, half + 0.35);
            mkWall(0.35, size + 1, -half - 0.35, 0);
            // right wall split around exit row
            const exitHalf = CELL / 2;
            mkWall(0.35, half - exitHalf + 0.35, half + 0.35, -(exitHalf + (half - exitHalf) / 2));
            mkWall(0.35, half - exitHalf + 0.35, half + 0.35, exitHalf + (half - exitHalf) / 2);
            // exit gate: glowing ramp marker
            exitGate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, CELL * 0.9),
                lit({ color: 0x2f9e6e, emissive: 0x2f9e6e, emissiveIntensity: 0.7 }));
            exitGate.position.set(half + 0.9, 0.08, exZ);
            boardGroup.add(exitGate);
            if (detailed) {
                ambient = buildDetailedProps(boardGroup, half, size, exZ);
                buildSkyline(boardGroup);
            } else {
                // seeded rooftop props: vents, AC boxes, antenna (visual seed deterministic)
                const deco = R.rng(entry.seed ^ 0xDEC0);
                const propMat = lit({ color: 0x6b7686, roughness: 0.8, metalness: 0.3 });
                for (let i = 0; i < 7; i++) {
                    const pw = 0.4 + deco() * 0.7, ph = 0.3 + deco() * 1.1, pd = 0.4 + deco() * 0.7;
                    const prop = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), propMat);
                    const side = Math.floor(deco() * 4);
                    const off = half + 1.2 + deco() * 0.8;
                    const along = (deco() - 0.5) * (size + 2);
                    prop.position.set(side === 0 ? along : side === 1 ? along : side === 2 ? -off : off, ph / 2, side === 0 ? -off : side === 1 ? off : along);
                    prop.castShadow = true;
                    boardGroup.add(prop);
                }
            }
            // selection ring
            selectRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 32),
                new THREE.MeshBasicMaterial({ color: 0xffd54f, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
            selectRing.rotation.x = -Math.PI / 2;
            selectRing.position.y = 0.07;
            selectRing.visible = false;
            selectRing.layers.set(LAYER_MARK);
            boardGroup.add(selectRing);

            // vehicle views
            session.state.vehicles.forEach((v, i) => {
                const color = v.target ? theme.target : theme.palette[(i + theme.palette.length - 1) % theme.palette.length];
                const mesh = makeVehicleMesh(v, v.target, color);
                mesh.userData.vehicleIndex = i;
                boardGroup.add(mesh);
                vehicleViews.push({ mesh, anim: null, lift: 0 });
            });
            syncVehicles(false);
        }

        function vehicleCenter(v) {
            const cx = v.ori === 'h' ? v.x + (v.len - 1) / 2 : v.x;
            const cy = v.ori === 'v' ? v.y + (v.len - 1) / 2 : v.y;
            return cellToWorld(cx, cy);
        }

        function syncVehicles(animate) {
            if (!session) return;
            session.state.vehicles.forEach((v, i) => {
                const view = vehicleViews[i];
                if (!view) return;
                const p = vehicleCenter(v);
                view.shake = 0;
                if (animate && !settings.reducedMotion) {
                    view.anim = { from: view.mesh.position.clone().setY(0), to: new THREE.Vector3(p.x, 0, p.z), t: 0 };
                } else {
                    view.mesh.position.set(p.x, view.mesh.position.y, p.z);
                    view.anim = null;
                }
            });
            updateSelectionVisual();
        }

        function updateSelectionVisual() {
            if (!session || !selectRing) return;
            const i = session.selected;
            const view = vehicleViews[i];
            if (view && !session.over) {
                const v = session.state.vehicles[i];
                const p = vehicleCenter(v);
                selectRing.visible = true;
                selectRing.position.set(p.x, 0.07, p.z);
                const s = Math.max(1, (v.len * CELL) / 2.4);
                selectRing.scale.set(v.ori === 'h' ? s : 1, v.ori === 'h' ? 1 : s, 1);
                showMarkers(i);
            } else {
                selectRing.visible = false;
                clearMarkers();
            }
        }

        function clearMarkers() {
            for (const m of markerMeshes) { boardGroup.remove(m); m.geometry.dispose(); m.material.dispose(); }
            markerMeshes = [];
        }

        function showMarkers(vIdx) {
            clearMarkers();
            const v = session.state.vehicles[vIdx];
            const acts = R.legalActions(session.state).filter(a => a.v === vIdx);
            for (const a of acts) {
                const nx = v.ori === 'h' ? v.x + a.dir * a.dist : v.x;
                const ny = v.ori === 'v' ? v.y + a.dir * a.dist : v.y;
                const cv = { x: v.ori === 'h' ? nx + (v.len - 1) / 2 : nx, y: v.ori === 'v' ? ny + (v.len - 1) / 2 : ny };
                const p = cellToWorld(cv.x, cv.y);
                const mk = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20),
                    new THREE.MeshBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
                mk.rotation.x = -Math.PI / 2;
                mk.position.set(p.x, 0.075, p.z);
                mk.userData.move = a;
                mk.layers.set(LAYER_MARK);
                boardGroup.add(mk);
                markerMeshes.push(mk);
            }
        }

        function flashInvalid(vIdx) {
            const view = vehicleViews[vIdx];
            if (!view || settings.reducedMotion) return;
            if (!view.shake) view.shakeBaseX = view.mesh.position.x;
            view.shake = 0.25;
        }

        function highlightHint(move) {
            session.selected = move.v;
            updateSelectionVisual();
        }

        function spawnConfetti() {
            if (settings.reducedMotion || !boardGroup) return;
            const geo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
            const count = Math.round(q.budget.confetti * (q.particles === 'high' ? 1 : 0.5));
            // one material per palette colour, shared by every piece (freed when the burst ends)
            const mats = theme.palette.map(c => new THREE.MeshBasicMaterial({ color: c }));
            confettiMats.push(...mats);
            for (let i = 0; i < count; i++) {
                const m = new THREE.Mesh(geo, mats[i % mats.length]);
                const p = cellToWorld(R.GRID - 1, R.EXIT_ROW);
                m.position.set(p.x + 0.8, 0.4, p.z);
                m.userData.vel = new THREE.Vector3((avRng() - 0.2) * 4, avRng() * 5 + 2, (avRng() - 0.5) * 4);
                m.layers.set(LAYER_MARK);
                boardGroup.add(m);
                vfx.push({ m, life: 1.4 });
            }
        }

        // raycast picking against explicit interaction layers only
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const groundHit = new THREE.Vector3();
        function aimAt(clientX, clientY, layer) {
            const r = canvas.getBoundingClientRect();
            ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
            raycaster.setFromCamera(ndc, camera);
            raycaster.layers.set(layer);
        }
        function castAt(clientX, clientY, layer) {
            aimAt(clientX, clientY, layer);
            return raycaster.intersectObjects(boardGroup ? boardGroup.children : [], true);
        }
        function pickVehicle(x, y) {
            const h = castAt(x, y, LAYER_GAME)[0];
            if (!h) return -1;
            let o = h.object;
            while (o && o.userData.vehicleIndex === undefined) o = o.parent;
            return o ? o.userData.vehicleIndex : -1;
        }
        function pickMarker(x, y) {
            // the selection ring shares the marker layer: take the first real marker
            const h = castAt(x, y, LAYER_MARK).find(i => i.object.userData.move);
            return h ? h.object.userData.move : null;
        }
        function pickCell(x, y) { // for drag axis projection
            // the lot surface is environment geometry (layer 0), so project onto the
            // board plane itself — this must also resolve over empty cells.
            aimAt(x, y, LAYER_GAME);
            if (!raycaster.ray.intersectPlane(groundPlane, groundHit)) return null;
            const wx = groundHit.x / CELL + (R.GRID - 1) / 2;
            const wy = groundHit.z / CELL + (R.GRID - 1) / 2;
            return { x: wx, y: wy };
        }

        // ---- graphics settings (applied live) ----
        let adaptiveScale = 1, frameTimes = [], fps = 0;
        let size = [0, 0], pixelRatio = 0;

        function markMaterials() {
            scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
        }
        function applyEnv() {
            const want = q.reflections === 'on';
            if (want && !envTex && POST) {
                try { envTex = POST.makeEnvironment(renderer); } catch (e) { envTex = null; }
            }
            const on = want && !!envTex;
            if (!!scene.environment !== on) { scene.environment = on ? envTex : null; markMaterials(); }
            scene.environmentIntensity = 0.45;
            hemi.intensity = on ? 0.5 : 0.85;
        }
        function fpsVisible(on) {
            let el = $('fps-meter');
            if (on && !el) {
                el = document.createElement('div');
                el.id = 'fps-meter';
                el.setAttribute('aria-hidden', 'true');
                el.textContent = '— fps';
                $('canvas-wrap').appendChild(el);
            }
            if (el) el.hidden = !on;
        }
        function setGraphics(saved) {
            q = G.resolve(saved, detected, gpuLevel);
            const mapSize = G.SHADOW_MAP[q.shadows];
            const had = renderer.shadowMap.enabled;
            renderer.shadowMap.enabled = mapSize > 0;
            key.castShadow = mapSize > 0;
            if (mapSize > 0 && key.shadow.mapSize.x !== mapSize) {
                key.shadow.mapSize.set(mapSize, mapSize);
                if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
            }
            if (had !== renderer.shadowMap.enabled) markMaterials(); // shadow state is baked into shaders
            applyEnv();
            adaptiveScale = 1;
            frameTimes = [];
            postKey = null;
            pixelRatio = 0; // re-apply size on the next frame
            fpsVisible(q.showFps);
            document.body.dataset.gfxPreset = q.preset;
            canvas.dataset.gfxPreset = q.preset;
            if (session && boardGroup && builtWith !== boardKey()) buildBoard(session.entry);
        }
        function applyQuality() { setGraphics(settings.graphics); }
        // Board assets depend on these settings and the preset's budget; a change rebuilds the board.
        function boardKey() { return [q.detail, q.particles, JSON.stringify(q.budget)].join('|'); }
        function applyTheme() { if (session) buildBoard(session.entry); }

        function targetRatio() {
            return Math.min(window.devicePixelRatio || 1, q.cap) * q.scale * adaptiveScale;
        }
        function applySize(force) {
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (!(w > 0 && h > 0)) return false;
            const ratio = targetRatio();
            if (!force && w === size[0] && h === size[1] && ratio === pixelRatio) return false;
            size = [w, h];
            pixelRatio = ratio;
            renderer.setPixelRatio(ratio);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            fitCamera();
            return true;
        }
        function resize() { applySize(true); }

        function disposeComposer() {
            if (!composer) return;
            for (const p of composer.passes) if (p.dispose) p.dispose();
            composer.dispose();
            composer = null;
        }
        function buildPost() {
            disposeComposer();
            if (!q.post || !POST || postFailed) return;
            try {
                composer = POST.buildComposer(renderer, scene, camera, q, size[0], size[1], pixelRatio, q.antialias === 'msaa');
            } catch (e) {
                // post-processing is an enhancement: render directly and say so in the Graphics panel
                postFailed = true;
                composer = null;
                if (infoListener) infoListener();
            }
        }
        // Adaptive resolution: ~90-frame average; step down 0.1 when slow, back up 0.05 when fast.
        function adapt(ms) {
            frameTimes.push(ms);
            if (frameTimes.length < 90) return;
            const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            frameTimes = [];
            fps = 1000 / avg;
            const el = $('fps-meter');
            if (el && !el.hidden) el.textContent = `${Math.round(fps)} fps · ${Math.round(pixelRatio * 100) / 100}×`;
            if (!q.adaptive) return;
            if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
            else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
        }

        let last = performance.now();
        function frame(now) {
            const ms = Math.min(250, now - last);
            const dt = Math.min(0.05, ms / 1000);
            last = now;
            adapt(ms);
            const moving = !settings.reducedMotion;
            const sel = session && !session.over ? session.selected : -1;
            vehicleViews.forEach((view, i) => {
                if (view.anim) {
                    view.anim.t += dt / 0.16;
                    if (view.anim.t >= 1) { view.mesh.position.set(view.anim.to.x, view.mesh.position.y, view.anim.to.z); view.anim = null; }
                    else {
                        const e = 1 - Math.pow(1 - view.anim.t, 3);
                        const y = view.mesh.position.y;
                        view.mesh.position.lerpVectors(view.anim.from, view.anim.to, e).setY(y);
                    }
                }
                if (view.shake) {
                    view.shake -= dt;
                    // offset from the stored base so the jiggle never drifts the car
                    if (view.shake > 0 && !view.anim) view.mesh.position.x = view.shakeBaseX + Math.sin(now * 0.09) * 0.03 * view.shake;
                    if (view.shake <= 0) { view.shake = 0; if (!view.anim) view.mesh.position.x = view.shakeBaseX; }
                }
                // selection pose: the selected vehicle lifts slightly (gentle idle bob unless reduced motion)
                if (q.detail === 'detailed') {
                    const target = i === sel ? 0.07 + (moving ? Math.sin(now * 0.004) * 0.025 : 0) : 0;
                    view.mesh.position.y += (target - view.mesh.position.y) * Math.min(1, dt * 14);
                } else if (view.mesh.position.y !== 0) view.mesh.position.y = 0;
            });
            for (let i = vfx.length - 1; i >= 0; i--) {
                const p = vfx[i];
                p.life -= dt;
                p.m.position.addScaledVector(p.m.userData.vel, dt);
                p.m.userData.vel.y -= 9.8 * dt;
                p.m.rotation.x += dt * 5; p.m.rotation.y += dt * 7;
                if (p.life <= 0) { boardGroup.remove(p.m); vfx.splice(i, 1); }
            }
            if (!vfx.length && confettiMats.length) { for (const m of confettiMats) m.dispose(); confettiMats = []; }
            if (exitGate) exitGate.material.emissiveIntensity = moving ? 0.55 + Math.sin(now * 0.004) * 0.2 : 0.6;
            if (ambient) {
                ambient.chevrons.forEach((c, i) => {
                    c.material.emissiveIntensity = moving ? 0.5 + 1.2 * Math.max(0, Math.sin(now * 0.005 - i * 0.9)) : 1.1;
                });
                ambient.beacon.material.emissiveIntensity = moving ? ((now % 1600) < 260 ? 4 : 0.35) : 2;
                if (ambient.dust && moving) {
                    const a = ambient.dust.geometry.attributes.position;
                    for (let i = 0; i < a.count; i++) {
                        let y = a.getY(i) + dt * (0.08 + (i % 5) * 0.03);
                        if (y > 4.4) y = 0.3;
                        a.setY(i, y);
                        a.setX(i, a.getX(i) + Math.sin(now * 0.0006 + i) * dt * 0.05);
                    }
                    a.needsUpdate = true;
                }
            }
            applySize(false);
            const pk = q.post && POST && !postFailed ? [q.ao, q.bloom, q.grade, q.antialias, q.budget.aoRes, q.budget.bloomRes, size[0], size[1], pixelRatio].join('|') : 'none';
            if (pk !== postKey) { postKey = pk; buildPost(); }
            if (composer) {
                try { (globalThis.GameOptions ? globalThis.GameOptions.draw(composer.renderer, () => composer.render(dt)) : composer.render(dt)); return; } catch (e) { postFailed = true; disposeComposer(); if (infoListener) infoListener(); }
            }
            (globalThis.GameOptions ? globalThis.GameOptions.draw(renderer, () => renderer.render(scene, camera)) : renderer.render(scene, camera));
        }

        function celebrate() { spawnConfetti(); }

        // Board cell -> client coordinates (used by pointer-input smoke tests).
        function screenPos(cellX, cellY) {
            const p = cellToWorld(cellX, cellY);
            const v = new THREE.Vector3(p.x, 0, p.z).project(camera);
            const r = canvas.getBoundingClientRect();
            return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
        }

        /** What the Graphics panel shows: GPU, auto choice, resolved tiers, pixels, post status. */
        function graphicsInfo() {
            let px = [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)];
            if (!px[0]) { const r = targetRatio(); px = [Math.round(window.innerWidth * r), Math.round(window.innerHeight * r)]; }
            return { gpu, level: gpuLevel, detected, resolved: q, pixels: px, postFailed: postFailed || (postLoadFailed && q.post), fps: Math.round(fps) };
        }
        function onInfo(fn) { infoListener = fn; }

        setGraphics(settings.graphics);

        return { buildBoard, syncVehicles, flashInvalid, highlightHint, applyQuality, setGraphics, graphicsInfo, onInfo, applyTheme, resetCamera, resize, frame, pickVehicle, pickMarker, pickCell, celebrate, screenPos, select: updateSelectionVisual };
    })();

    // ================= UI =================
    function vehicleName(v) {
        if (v.target) return T('red car');
        const key = v.ori === 'h' ? (v.len === 3 ? N('sideways van {id}') : N('sideways car {id}')) : (v.len === 3 ? N('upright van {id}') : N('upright car {id}'));
        return T(key, { id: v.id });
    }

    const ui = {
        refreshAll() { this.refreshHud(); this.refreshVehicleList(); this.refreshObjective(); },
        refreshHud() {
            if (!session) return;
            $('chip-mode').textContent = modeLabel(session.mode) + (session.entry.challenge ? ' · ' + kindLabel(session.entry.challenge.kind) : '');
            $('chip-moves').textContent = T('Moves {n} / par {par}', { n: session.state.moves, par: session.entry.par });
            $('chip-time').textContent = formatTime(sessionElapsedSec());
            const lim = session.entry.challenge;
            const limChip = $('chip-limit');
            if (lim && lim.moveLimit) { limChip.hidden = false; limChip.textContent = T('Limit {n}', { n: lim.moveLimit }); }
            else if (lim && lim.timeLimit) { limChip.hidden = false; limChip.textContent = T('Left {time}', { time: formatTime(Math.max(0, lim.timeLimit - sessionElapsedSec())) }); }
            else limChip.hidden = true;
            $('btn-undo').disabled = $('tray-undo').disabled = !session.history.length || session.over;
            $('btn-hint').disabled = $('tray-hint').disabled = session.over || (session.entry.challenge && session.entry.challenge.noHint);
        },
        refreshObjective() {
            if (!session) return;
            const blockers = R.exitBlockers(session.state);
            $('objective-desc').textContent = session.mode === 'learn' && session.tutorialText && session.state.moves === 0
                ? T(session.tutorialText)
                : blockers.length === 1 ? T('Guide the red car to the glowing exit gate. 1 vehicle blocks the lane.')
                : blockers.length ? T('Guide the red car to the glowing exit gate. {n} vehicles block the lane.', { n: blockers.length })
                : T('The lane is clear — drive the red car out!');
            $('progress-desc').textContent =
                T('Mode: {mode} · Stage par {par} · Hints used {hints} · Wins {wins}', { mode: modeLabel(session.mode), par: session.entry.par, hints: session.hintsUsed, wins: progress.wins }) +
                (session.entry.challenge ? ' · ' + T('Constraint: {kind}', { kind: kindLabel(session.entry.challenge.kind) }) : '');
            $('session-desc').textContent = T('Seed {seed} · content v{version} · replay log {n} commands', {
                seed: session.entry.seed.toString(16), version: session.entry.version, n: session.commands.length });
        },
        refreshVehicleList() {
            if (!session) return;
            const ul = $('vehicle-list');
            // rebuild only when the roster changes: relabelling in place keeps
            // keyboard focus on the button the player is currently using
            if (ul.children.length !== session.state.vehicles.length) {
                ul.innerHTML = '';
                session.state.vehicles.forEach((v, i) => {
                    const li = document.createElement('li');
                    const b = document.createElement('button');
                    b.addEventListener('click', () => selectVehicle(i));
                    li.appendChild(b);
                    ul.appendChild(li);
                });
            }
            session.state.vehicles.forEach((v, i) => {
                const b = ul.children[i].firstChild;
                b.textContent = T('{vehicle} at column {c}, row {r}', { vehicle: vehicleName(v), c: v.x + 1, r: v.y + 1 }) + (v.target ? T(' (target)') : '');
                b.setAttribute('aria-pressed', i === session.selected ? 'true' : 'false');
            });
        },
    };

    function modeLabel(m) {
        return T({ learn: N('Learn'), journey: N('Journey'), daily: N('Daily'), practice: N('Practice'), challenge: N('Challenge'), score: N('Score chase') }[m] || m);
    }
    function kindLabel(k) {
        return T({ 'move-limit': N('move limit'), speed: N('speed'), 'no-hint': N('no hints') }[k] || k);
    }
    function formatTime(s) {
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function selectVehicle(i) {
        if (!session || session.over) return;
        session.selected = i;
        A.playSfx('select');
        render.select(); // move the ring/markers without snapping in-flight slides
        ui.refreshVehicleList();
        announce(T('{vehicle} selected.', { vehicle: vehicleName(session.state.vehicles[i]) }));
    }

    // ================= screens wiring =================
    const MODES = [
        { id: 'learn', title: N('Learn'), desc: N('Interactive lessons — one rule at a time. Unranked.'), ranked: false },
        { id: 'journey', title: N('Journey'), desc: N('{n} authored stages with mastery checks. Progress saved.'), ranked: true },
        { id: 'daily', title: N('Daily'), desc: N('One shared lot per UTC day. Ranked, validated on the server.'), ranked: true },
        { id: 'practice', title: N('Practice'), desc: N('Pick a difficulty, unlimited retry and undo. Unranked.'), ranked: false },
        { id: 'challenge', title: N('Challenge'), desc: N('Move limits, speed targets, restricted tools.'), ranked: true },
        { id: 'score', title: N('Score chase'), desc: N('Chase the leaderboard on fixed validated seeds.'), ranked: true },
    ];

    function buildModeList() {
        const list = $('mode-list');
        list.innerHTML = '';
        for (const m of MODES) {
            const b = document.createElement('button');
            b.className = 'menu-item';
            b.setAttribute('role', 'listitem');
            let meta = m.ranked ? T('Ranked') : T('Unranked');
            if (m.id === 'journey') meta = T('Stage {n} of {total}', { n: progress.journeyUnlocked + 1, total: C.JOURNEY_COUNT });
            if (m.id === 'daily') meta = progress.lastDaily === todayKey() ? T('Done today') : T('New today');
            b.innerHTML = '<span><span class="title">' + T(m.title) + '</span><br><span class="desc">' + T(m.desc, { n: C.JOURNEY_COUNT }) + '</span></span><span class="meta">' + meta + '</span>';
            b.addEventListener('click', () => { A.playSfx('click'); openSetup(m.id); });
            list.appendChild(b);
        }
    }

    let setupMode = null;
    function openSetup(mode, quiet) {
        setupMode = mode;
        setAppState('preparing', quiet ? null : T('{mode} setup', { mode: modeLabel(mode) }));
        const list = $('setup-list');
        list.innerHTML = '';
        $('setup-h').textContent = modeLabel(mode);
        const info = {
            learn: N('Four short lessons. Expected 2–4 minutes. Unranked, undo allowed.'),
            journey: N('Stages get denser and deeper; every tenth is a mastery stage. Ranked, undo and hints allowed with score penalties.'),
            daily: N('Same lot for everyone this UTC day. Ranked; score is validated by the server from your replay log.'),
            practice: N('Casual generated lots. Restart and undo freely; no rating impact.'),
            challenge: N('Constraints apply — watch the HUD limit chip. Ranked.'),
            score: N('Fixed seeds, asynchronous global and friends comparison. Ranked.'),
        }[mode];
        $('setup-info').textContent = T(info);

        function addItem(label, meta, fn, disabled) {
            const b = document.createElement('button');
            b.className = 'menu-item';
            b.disabled = !!disabled;
            b.innerHTML = '<span class="title">' + label + '</span><span class="meta">' + (meta || '') + '</span>';
            b.addEventListener('click', () => { A.playSfx('click'); fn(); });
            list.appendChild(b);
        }

        if (mode === 'learn') {
            C.TUTORIALS.forEach((t, i) => addItem((i + 1) + '. ' + T(t.title), progress.tutorialsDone.includes(t.id) ? T('completed') : '', () => startLearn(i)));
        } else if (mode === 'journey') {
            for (let i = 0; i < C.JOURNEY_COUNT; i++) {
                const locked = i > progress.journeyUnlocked;
                const stars = progress.stars['journey-' + (i + 1)] || 0;
                addItem(T('Stage {n}', { n: i + 1 }) + (C.difficultyFor(i).mastery ? ' · ' + T('Mastery') : ''),
                    locked ? T('locked') : '★'.repeat(stars) || T('new'), () => startJourney(i), locked);
            }
        } else if (mode === 'daily') {
            addItem(T('Today’s lot ({date})', { date: todayKey() }), T('one shared lot per UTC day'), () => startDaily());
        } else if (mode === 'practice') {
            addItem(T('Easy'), T('short solutions'), () => startPractice(0));
            addItem(T('Medium'), T('deeper planning'), () => startPractice(1));
            addItem(T('Hard'), T('dense lots'), () => startPractice(2));
        } else if (mode === 'challenge') {
            for (let i = 0; i < 6; i++) {
                const e = C.challengeLevel(i);
                addItem(T('Challenge {n} — {kind}', { n: i + 1, kind: kindLabel(e.challenge.kind) }),
                    e.challenge.moveLimit ? T('move limit {n}', { n: e.challenge.moveLimit }) : e.challenge.timeLimit ? T('{n}s target', { n: e.challenge.timeLimit }) : T('no hints'),
                    () => startChallenge(i));
            }
        } else if (mode === 'score') {
            for (let i = 0; i < 5; i++) addItem(T('Fixed seed {n}', { n: i + 1 }), T('global board'), () => startScore(i));
        }
    }

    // ================= mode starters =================
    function beginRound(mode, entry, reason) {
        newSession(mode, entry);
        closeAllOverlays();
        setAppState('active', reason);
        render.resize();
        A.startMusic();
        A.startAmbience();
        session.lastTick = performance.now();
        announce((reason || '') + ' ' + $('objective-desc').textContent);
        if (mode === 'learn') announce(session.tutorialText || '');
    }

    function startLearn(i) {
        const t = C.TUTORIALS[i];
        const entry = { id: t.id, version: C.CONTENT_VERSION, seed: 100 + i, level: t.level, par: 2, mechanics: ['slide'], tutorial: true, theme: 'day', mastery: false };
        beginRound('learn', entry, T('Lesson {n}: {title}.', { n: i + 1, title: T(t.title) }) + ' ' + T(t.text));
        session.tutorialText = t.text;
        $('objective-desc').textContent = T(t.text);
    }
    function startJourney(i) { beginRound('journey', C.journeyLevel(i), T('Journey stage {n}.', { n: i + 1 })); }
    function startPractice(tier) {
        const gen = C.practiceLevel(tier);
        const attempt = (session && session.practiceAttempt) || 0;
        beginRound('practice', gen(attempt), T('Practice round.'));
        session.practiceTier = tier;
    }
    function startChallenge(i) { beginRound('challenge', C.challengeLevel(i), T('Challenge: {kind}.', { kind: kindLabel(C.challengeLevel(i).challenge.kind) })); }
    function startScore(i) {
        const entry = C.journeyLevel(5 + i * 7);
        beginRound('score', entry, T('Score chase seed {n}.', { n: i + 1 }));
    }
    function startDaily() {
        const finish = day => beginRound('daily', C.dailyLevel(day), T('Daily challenge for {day}.', { day }));
        // hosted: the platform exposes no time route, so key the day from the local UTC clock
        if (platform.hosted || onPlatformHost) return finish(todayKey());
        // local dev: synchronize to the game server's clock with round-trip adjustment
        const t0 = Date.now();
        fetch('/api/v1/time').then(r => r.json()).then(j => {
            const rtt = Date.now() - t0;
            finish(dayFromMs(j.now + Math.round(rtt / 2)));
        }).catch(() => finish(todayKey()));
    }
    function todayKey() { return dayFromMs(Date.now()); }
    function dayFromMs(ms) {
        const d = new Date(ms);
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }

    // ================= results =================
    let lastFocus = null;
    function openOverlay(id) {
        lastFocus = document.activeElement;
        $(id).classList.add('active');
        if (id === 'overlay-settings') syncGraphicsUi();
        const first = $(id).querySelector('button, input, select');
        // preventScroll + reset: a low first control must not scroll the
        // heading away; overlays always open at their top.
        if (first) first.focus({ preventScroll: true });
        for (const n of [$(id), ...$(id).querySelectorAll('*')]) if (n.scrollTop) n.scrollTop = 0;
    }
    function closeOverlay(id) {
        $(id).classList.remove('active');
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }
    function closeAllOverlays() { document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active')); }

    // Results text, re-rendered in place when the language changes.
    let lastResults = null;
    function renderResultsText() {
        const r = lastResults;
        if (!r) return;
        const { won, sc, loseReason, moves, secs } = r;
        $('results-h').textContent = won ? T('Lot cleared!') : T('Round over');
        $('results-headline').textContent = won
            ? T('Solved in {moves} moves and {time}.', { moves, time: formatTime(secs) })
            : T(loseReason || N('The lot stayed jammed.'));
        const rows = [
            [N('Completion base'), sc.base], [N('Move efficiency'), sc.parBonus], [N('Time bonus'), sc.timeBonus],
            [N('Hint penalty'), sc.hintPenalty], [N('Blocked-attempt penalty'), sc.invalidPenalty],
            [N('Challenge bonus'), sc.challengeBonus],
        ];
        $('score-breakdown').innerHTML = rows.filter(row => row[1] !== 0).map(row => '<tr><td>' + T(row[0]) + '</td><td>' + row[1] + '</td></tr>').join('') +
            '<tr class="total"><td>' + T('Total') + '</td><td>' + sc.total + '</td></tr>';
        $('results-progress').textContent = won
            ? T('Career wins: {wins} · Journey stage {n} unlocked', { wins: progress.wins, n: progress.journeyUnlocked + 1 })
            : T('Retry to keep your streak alive.');
        if ($('submit-row').style.display !== 'none') {
            $('btn-submit-score').textContent = platform.hosted && platform.nickname
                ? T('Submit as {name}', { name: platform.nickname })
                : T('Submit score');
        }
        if (lbLine) renderLbLine();
    }
    function showResults(won, sc, loseReason) {
        setAppState('results');
        if (won) render.celebrate();
        lastResults = { won, sc, loseReason, moves: session.state.moves, secs: sessionElapsedSec() };
        lbLine = null;
        renderResultsText();
        // clients never submit platform scores: the validated submit exists only on the dev server
        const ranked = ['journey', 'daily', 'score'].includes(session.mode) && won && !onPlatformHost;
        $('submit-row').style.display = ranked ? '' : 'none';
        if (ranked) {
            // hosted play submits under the account nickname; the free-text name
            // field only exists for the local dev server
            $('submit-name').style.display = platform.hosted ? 'none' : '';
            $('btn-submit-score').textContent = platform.hosted && platform.nickname
                ? T('Submit as {name}', { name: platform.nickname })
                : T('Submit score');
        }
        $('submit-status').textContent = '';
        $('leaderboard-table').innerHTML = '<tr><td>' + T('Loading…') + '</td></tr>';
        const modeDef = MODES.find(m => m.id === session.mode);
        if (won && modeDef && modeDef.ranked && platform.hosted && PF) postToLeaderboard(sc.total);
        else { $('results-lb').hidden = true; refreshLeaderboard(); }
        const next = $('btn-next');
        next.style.display = won ? '' : 'none';
        openOverlay('overlay-results');
    }

    // Signed in only: a won ranked round posts its total through the platform
    // (score-script.js), shows the player's rank and then reloads the board.
    let lbLine = null;   // { pending } or the posting result, re-rendered on a language change
    function renderLbLine() {
        const r = lbLine, line = $('results-lb');
        if (!r) return;
        line.textContent = r.pending ? GFX_S.sh.lbPosting : !r.posted ? GFX_S.sh.lbNotPosted
            : r.rank ? GFX_S.sh.lbRank.replace('{rank}', r.rank) : GFX_S.sh.lbPosted;
    }
    function postToLeaderboard(total) {
        const line = $('results-lb'), s = session;
        line.hidden = false;
        lbLine = { pending: true };
        renderLbLine();
        PF.submitScore(total).then(r => {
            if (session !== s) return;
            lbLine = r;
            renderLbLine();
            refreshLeaderboard();
        });
    }

    function refreshLeaderboard() {
        // Unranked rounds (Learn, Practice) never reach a board: say so plainly
        // instead of reporting the leaderboard as offline.
        const modeDef = MODES.find(m => m.id === session.mode);
        if (modeDef && !modeDef.ranked) {
            $('leaderboard-table').innerHTML = '<tr><td>' + T('{mode} rounds are unranked — no leaderboard entry.', { mode: T(modeDef.title) }) + '</td></tr>';
            return;
        }
        if (platform.hosted) return refreshHostedLeaderboard();
        const query = new URLSearchParams({ board: 'global', mode: session.mode, seed: String(session.entry.seed), contentVersion: String(C.CONTENT_VERSION) });
        if (session.mode === 'daily') query.set('day', session.entry.day);
        fetch('/api/v1/scores?' + query).then(r => r.json()).then(j => {
            const t = $('leaderboard-table');
            if (!j.entries || !j.entries.length) { t.innerHTML = '<tr><td>' + T('No validated scores yet — be the first.') + '</td></tr>'; return; }
            t.innerHTML = '<tr><th>' + T('Name') + '</th><th>' + T('Score') + '</th><th>' + T('Moves') + '</th><th>' + T('Time') + '</th></tr>';
            for (const e of j.entries.slice(0, 10)) {
                const tr = document.createElement('tr');
                for (const cell of [String(e.name), String(e.score), String(e.moves), formatTime(e.seconds | 0)]) {
                    const td = document.createElement('td');
                    td.textContent = cell; // names come from the network: never inject markup
                    tr.appendChild(td);
                }
                t.appendChild(tr);
            }
        }).catch(() => { showLocalBoard(); });
    }

    // Hosted boards are platform-owned and read-only: game info → leaderboardId →
    // entries with display names. Anything unavailable falls back to the personal best.
    async function refreshHostedLeaderboard() {
        const t = $('leaderboard-table');
        try {
            const rows = await PF.leaderboardRows(10);
            if (rows) {
                if (!rows.length) { t.innerHTML = '<tr><td>' + T('No entries yet — be the first.') + '</td></tr>'; return; }
                t.innerHTML = '<tr><th>' + T('Rank') + '</th><th>' + T('Name') + '</th><th>' + T('Score') + '</th></tr>';
                for (const e of rows) {
                    const tr = document.createElement('tr');
                    for (const cell of [String(e.rank), e.name, String(e.score)]) {
                        const td = document.createElement('td');
                        td.textContent = cell; // names come from the network: never inject markup
                        tr.appendChild(td);
                    }
                    t.appendChild(tr);
                }
                return;
            }
        } catch (e) { /* platform unreachable: fall through to the local view */ }
        showLocalBoard();
    }

    function showLocalBoard() {
        const t = $('leaderboard-table');
        const best = progress.bestScores[boardKey(session.mode, session.entry)];
        t.innerHTML = '<tr><td>' + (best != null
            ? T('Personal best: {score} — global board unavailable for this round.', { score: best })
            : T('Leaderboard offline — playing locally.')) + '</td></tr>';
    }

    function submitScore() {
        if (!session || !session.won) return;
        // hosted play submits under the account nickname; local dev keeps the name field
        const name = platform.hosted
            ? (platform.nickname || PF.fallbackName(PF.sub))
            : ($('submit-name').value.trim() || T('Guest'));
        const body = {
            name, mode: session.mode === 'score' ? 'score' : session.mode,
            day: session.entry.day || todayKey(),
            seed: session.entry.seed, contentVersion: session.entry.version,
            commands: session.commands, score: session.finalScore.total,
            seconds: sessionElapsedSec(), hints: session.hintsUsed, invalid: session.invalidCount,
        };
        $('submit-status').textContent = T('Validating…');
        const headers = { 'content-type': 'application/json' };
        fetch('/api/v1/scores', { method: 'POST', headers, body: JSON.stringify(body) })
            .then(async r => {
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || 'rejected');
                $('submit-status').textContent = T('Score accepted (validated server-side).');
                refreshLeaderboard();
            })
            .catch(e => {
                $('submit-status').textContent = platform.hosted
                    ? T('Validation server unavailable — score kept locally and in your account cloud save.')
                    : T('Submit failed: {reason}', { reason: e.message });
            });
    }

    // ================= input: pointer / touch =================
    const canvas = $('game-canvas');
    let drag = null;
    canvas.addEventListener('pointerdown', e => {
        if (!session || session.over || appState !== 'active') return;
        canvas.setPointerCapture(e.pointerId);
        const marker = render.pickMarker(e.clientX, e.clientY);
        if (marker) { executeMove(marker.v, marker.dir, marker.dist, 'p' + e.pointerId + '-' + Date.now()); return; }
        const vi = render.pickVehicle(e.clientX, e.clientY);
        if (vi >= 0) {
            selectVehicle(vi);
            drag = { id: e.pointerId, v: vi, sx: e.clientX, sy: e.clientY, moved: false, from: render.pickCell(e.clientX, e.clientY) };
        }
    });
    canvas.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.hypot(dx, dy) > 8) drag.moved = true;
    });
    canvas.addEventListener('pointerup', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const d = drag; drag = null;
        if (!d.moved || !settings.holdDrag) return; // tap = select only
        const v = session.state.vehicles[d.v];
        const cell = render.pickCell(e.clientX, e.clientY);
        if (!cell || !d.from) return;
        // travel is measured from where the vehicle was grabbed, so the grab point
        // on the body (nose, middle or tail) never biases the distance
        const cells2 = Math.round(v.ori === 'h' ? cell.x - d.from.x : cell.y - d.from.y);
        if (cells2 === 0) return;
        const dir = Math.sign(cells2);
        // an over-drag parks against the nearest obstacle instead of failing outright
        const reach = R.legalActions(session.state)
            .filter(a => a.v === d.v && a.dir === dir)
            .reduce((m, a) => Math.max(m, a.dist), 0);
        // reach 0 falls through to executeMove so the blocked move is announced
        const dist = Math.max(1, Math.min(Math.abs(cells2), reach));
        executeMove(d.v, dir, dist, 'd' + e.pointerId + '-' + Date.now());
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });

    // ================= input: keyboard =================
    document.addEventListener('keydown', e => {
        if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        const act = keyAction(e.code);
        if (act === 'menu') {
            if ($('overlay-settings').classList.contains('active')) return closeOverlay('overlay-settings');
            if ($('overlay-help').classList.contains('active')) return closeOverlay('overlay-help');
            if (appState === 'active') return pauseGame();
            if (appState === 'paused') return resumeGame();
            return;
        }
        if (appState !== 'active' || !session || session.over) return;
        if (e.key === 'Tab') {
            // Only the board itself traps Tab (to cycle vehicles); Shift+Tab and Tab
            // from anywhere else keep the normal focus order so the HUD controls
            // stay reachable by keyboard.
            if (document.activeElement !== canvas || e.shiftKey) return;
            e.preventDefault();
            const n = session.state.vehicles.length;
            selectVehicle((session.selected + 1) % n);
        } else if (['left', 'right', 'up', 'down'].includes(act)) {
            e.preventDefault();
            const v = session.state.vehicles[session.selected];
            const map = v.ori === 'h' ? { left: -1, right: 1 } : { up: -1, down: 1 };
            if (map[act] !== undefined) executeMove(session.selected, map[act], 1, 'k' + (++cmdCounter));
            else { A.playSfx('invalid'); announce(v.ori === 'h' ? T('That vehicle only moves left and right.') : T('That vehicle only moves up and down.')); }
        } else if (act === 'undo') undoMove();
        else if (act === 'hint') requestHint();
        else if (act === 'restart') restartRound();
        else if (act === 'camera') render.resetCamera();
        else if (act === 'pause') pauseGame();
    });

    // ================= input: gamepad =================
    let padPrev = {};
    function pollGamepad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = pads && pads[0];
        if (!gp || appState !== 'active' || !session || session.over) return;
        const pressed = i => gp.buttons[i] && gp.buttons[i].pressed;
        const once = (name, down) => { const was = padPrev[name]; padPrev[name] = down; return down && !was; };
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        const v = session.state.vehicles[session.selected];
        if (once('a', pressed(0))) { /* confirm = select */ A.playSfx('select'); }
        if (once('b', pressed(1))) undoMove();
        if (once('start', pressed(9))) pauseGame();
        if (once('l', pressed(14) || ax < -0.6)) { if (v.ori === 'h') executeMove(session.selected, -1, 1, 'g' + (++cmdCounter)); }
        if (once('r', pressed(15) || ax > 0.6)) { if (v.ori === 'h') executeMove(session.selected, 1, 1, 'g' + (++cmdCounter)); }
        if (once('u', pressed(12) || ay < -0.6)) { if (v.ori === 'v') executeMove(session.selected, -1, 1, 'g' + (++cmdCounter)); }
        if (once('d', pressed(13) || ay > 0.6)) { if (v.ori === 'v') executeMove(session.selected, 1, 1, 'g' + (++cmdCounter)); }
        if (once('x', pressed(2))) requestHint();
        if (once('y', pressed(3))) selectVehicle((session.selected + 1) % session.state.vehicles.length);
    }

    // ================= pause / lifecycle =================
    function pauseGame() {
        if (appState !== 'active') return;
        setAppState('paused', T('Paused.'));
        A.playSfx('pause');
        A.suspendAll();
        openOverlay('overlay-pause');
    }
    function resumeGame() {
        if (!session) return leaveRound();
        closeAllOverlays();
        setAppState('active', T('Resumed.'));
        A.startMusic();
        A.startAmbience();
        session.lastTick = performance.now();
    }
    function restartRound() {
        if (!session) return;
        if (session.mode === 'practice') session.practiceAttempt = session.practiceAttempt || 0;
        beginRound(session.mode, session.entry, T('Round restarted.'));
    }
    function leaveRound() {
        closeAllOverlays();
        A.suspendAll();
        session = null;
        setAppState('mode-select', T('Choose a mode.'));
        buildModeList();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && appState === 'active') pauseGame();
    });

    // ================= buttons =================
    function on(id, fn) { $(id).addEventListener('click', () => { A.playSfx('click'); fn(); }); }
    on('btn-play', () => { buildModeList(); setAppState('mode-select', T('Choose a mode.')); });
    on('btn-daily', () => startDaily());
    on('btn-journey-resume', () => startJourney(progress.journeyUnlocked));
    on('btn-settings', () => openOverlay('overlay-settings'));
    on('btn-help', () => { renderKeyHelp(); openOverlay('overlay-help'); });
    on('btn-sh-signin', () => PF.signIn());
    on('btn-sh-invite', async () => {
        const link = PF.inviteLink();
        if (!link) return;
        try { await navigator.clipboard.writeText(link); toast(SH_S.copied); }
        catch (e) { toast(SH_S.copyFailed); }
    });
    // Graphics / StarHermit strings (gfx.js tables) follow the game language.
    let GFX_S = G.strings(G.pickLocale(I.lang()));
    let SH_S = GFX_S.sh;
    function labelAccountButtons() {
        for (const [id, key] of [['btn-sh-signin', 'signIn'], ['btn-sh-invite', 'invite']]) $(id).textContent = SH_S[key];
    }
    labelAccountButtons();
    refreshAccount();
    on('btn-modes-back', () => setAppState('title'));
    on('btn-setup-back', () => setAppState('mode-select'));
    on('btn-pause', () => pauseGame());
    on('btn-resume', () => resumeGame());
    on('btn-pause-settings', () => openOverlay('overlay-settings'));
    on('btn-pause-help', () => openOverlay('overlay-help'));
    on('btn-leave', () => leaveRound());
    on('btn-undo', () => undoMove());
    on('tray-undo', () => undoMove());
    on('btn-hint', () => requestHint());
    on('tray-hint', () => requestHint());
    on('btn-restart', () => restartRound());
    on('tray-restart', () => restartRound());
    on('btn-camera', () => render.resetCamera());
    on('btn-submit-score', () => submitScore());
    on('btn-next', () => {
        closeAllOverlays();
        if (session.mode === 'journey') {
            const idx = parseInt(session.entry.id.split('-')[1], 10);
            if (idx < C.JOURNEY_COUNT) startJourney(idx); else leaveRound();
        } else if (session.mode === 'learn') {
            const i = C.TUTORIALS.findIndex(t => t.id === session.entry.id);
            if (i >= 0 && i + 1 < C.TUTORIALS.length) startLearn(i + 1); else leaveRound();
        } else if (session.mode === 'practice') { session.practiceAttempt = (session.practiceAttempt || 0) + 1; startPractice(session.practiceTier || 0); }
        else leaveRound();
    });
    on('btn-retry', () => { closeAllOverlays(); restartRound(); });
    on('btn-results-exit', () => leaveRound());
    on('btn-settings-close', () => closeOverlay('overlay-settings'));
    on('btn-help-close', () => closeOverlay('overlay-help'));
    on('btn-replay-tutorial', () => { closeOverlay('overlay-settings'); startLearn(0); });
    const syncScrim = () => {
        const any = $('rail-left').classList.contains('open') || $('rail-right').classList.contains('open');
        const scrim = $('drawer-scrim');
        if (scrim) scrim.hidden = !any;
    };
    on('btn-rail-left', () => { $('rail-left').classList.toggle('open'); $('rail-right').classList.remove('open'); syncScrim(); });
    on('btn-rail-right', () => { $('rail-right').classList.toggle('open'); $('rail-left').classList.remove('open'); syncScrim(); });
    // the open drawer covers the status bar, so it needs its own close control
    on('btn-rail-left-close', () => { $('rail-left').classList.remove('open'); syncScrim(); $('btn-rail-left').focus(); });
    on('btn-rail-right-close', () => { $('rail-right').classList.remove('open'); syncScrim(); $('btn-rail-right').focus(); });
    // tapping outside an open drawer closes it and restores focus to its opener
    if ($('drawer-scrim')) $('drawer-scrim').addEventListener('click', () => {
        const wasLeft = $('rail-left').classList.contains('open');
        $('rail-left').classList.remove('open'); $('rail-right').classList.remove('open'); syncScrim();
        (wasLeft ? $('btn-rail-left') : $('btn-rail-right')).focus();
    });

    // settings controls
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
        $('vol-' + bus).addEventListener('input', e => {
            settings.volumes[bus] = e.target.value / 100;
            A.setVolume(bus, settings.volumes[bus]);
            saveSettings();
        });
    }
    $('opt-mute').addEventListener('change', e => { settings.muted = e.target.checked; A.setMuted(settings.muted); saveSettings(); });

    // ================= Graphics settings panel =================
    const tierName = t => GFX_S.tiers[t] || t;
    function applyGraphics() {
        render.setGraphics(settings.graphics);
        syncGraphicsUi();
        saveSettings();
    }
    // Static Graphics labels; re-run on a language change (the panel itself is not rebuilt).
    function labelGraphicsPanel() {
        $('gfx-h').textContent = GFX_S.graphics;
        $('gfx-l-preset').textContent = GFX_S.quality;
        $('gfx-l-scale').textContent = GFX_S.renderScale;
        $('gfx-l-adaptive').textContent = GFX_S.adaptive;
        $('gfx-l-fps').textContent = GFX_S.showFps;
        $('gfx-note').textContent = GFX_S.postFailed;
        for (const o of $('gfx-preset').options) if (o.value !== 'auto') o.textContent = tierName(o.value);
        for (const cat of Object.keys(G.CATEGORIES)) {
            const sel = $('gfx-' + cat);
            if (!sel) continue;
            sel.previousElementSibling.textContent = GFX_S.cats[cat];
            for (const o of sel.options) if (o.value !== 'preset') o.textContent = tierName(o.value);
        }
    }
    function buildGraphicsPanel() {
        labelGraphicsPanel();
        const presetSel = $('gfx-preset');
        for (const p of ['auto'].concat(G.PRESETS)) {
            const o = document.createElement('option');
            o.value = p; o.textContent = p === 'auto' ? GFX_S.auto : tierName(p);
            presetSel.appendChild(o);
        }
        presetSel.addEventListener('change', () => {
            settings.graphics = G.withPreset(settings.graphics, presetSel.value); // a preset clears overrides
            applyGraphics();
        });
        const cats = $('gfx-cats');
        for (const [cat, tiers] of Object.entries(G.CATEGORIES)) {
            const lab = document.createElement('label');
            const span = document.createElement('span');
            span.textContent = GFX_S.cats[cat];
            const sel = document.createElement('select');
            sel.id = 'gfx-' + cat;
            sel.dataset.gfxCat = cat;
            for (const t of ['preset'].concat(tiers)) {
                const o = document.createElement('option');
                o.value = t; o.textContent = t === 'preset' ? GFX_S.fromPreset : tierName(t);
                sel.appendChild(o);
            }
            sel.addEventListener('change', () => {
                if (sel.value === 'preset') delete settings.graphics[cat];
                else settings.graphics[cat] = sel.value;
                applyGraphics();
            });
            lab.append(span, sel);
            cats.appendChild(lab);
        }
        const scale = $('gfx-scale');
        scale.addEventListener('input', () => { $('gfx-scale-val').textContent = scale.value + '%'; });
        scale.addEventListener('change', () => { settings.graphics.render_scale = scale.value / 100; applyGraphics(); });
        $('gfx-adaptive').addEventListener('change', e => { settings.graphics.adaptive = e.target.checked; applyGraphics(); });
        $('gfx-fps').addEventListener('change', e => { settings.graphics.show_fps = e.target.checked; applyGraphics(); });
        render.onInfo(syncGraphicsUi);
    }
    function syncGraphicsUi() {
        const info = render.graphicsInfo();
        const g = settings.graphics;
        const r = info ? info.resolved : G.resolve(g, 'low');
        const presetSel = $('gfx-preset');
        presetSel.options[0].textContent = GFX_S.auto.replace('{tier}', tierName(info ? info.detected : 'low'));
        presetSel.value = G.PRESETS.includes(g.preset) ? g.preset : 'auto';
        for (const [cat, tiers] of Object.entries(G.CATEGORIES)) {
            const sel = $('gfx-' + cat);
            sel.options[0].textContent = GFX_S.fromPreset.replace('{tier}', tierName(G.presetTier(r.preset, cat)));
            sel.value = tiers.includes(g[cat]) ? g[cat] : 'preset';
        }
        const pct = Math.round((Number(g.render_scale) || 1) * 100);
        $('gfx-scale').value = pct;
        $('gfx-scale-val').textContent = pct + '%';
        $('gfx-adaptive').checked = g.adaptive !== false;
        $('gfx-fps').checked = !!g.show_fps;
        $('gfx-summary').textContent = info
            ? [info.gpu || GFX_S.gpuUnknown, info.level != null ? GFX_S.level.replace('{n}', info.level) : null, G.describe(r, info.pixels, GFX_S)].filter(Boolean).join(' · ')
            : GFX_S.postFailed;
        $('gfx-note').hidden = !(info && info.postFailed);
        $('gfx-section').dataset.gfxPreset = r.preset;
    }
    buildGraphicsPanel();
    syncGraphicsUi();
    const themeSel = $('opt-theme');
    C.THEMES.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = T(t.name); themeSel.appendChild(o); });
    themeSel.addEventListener('change', e => { settings.theme = e.target.value; render.applyTheme(); saveSettings(); });
    $('opt-reduced-motion').addEventListener('change', e => { settings.reducedMotion = e.target.checked; applySettingsToDom(); saveSettings(); });
    $('opt-high-contrast').addEventListener('change', e => { settings.highContrast = e.target.checked; applySettingsToDom(); saveSettings(); });
    $('opt-large-text').addEventListener('change', e => { settings.largeText = e.target.checked; applySettingsToDom(); saveSettings(); });
    $('opt-captions').addEventListener('change', e => { settings.captions = e.target.checked; saveSettings(); });
    $('opt-hold-drag').addEventListener('change', e => { settings.holdDrag = e.target.checked; saveSettings(); });
    $('opt-lefty').addEventListener('change', e => { settings.lefty = e.target.checked; applySettingsToDom(); saveSettings(); });

    // ================= main loop =================
    let rafId = null;
    let hudSecond = -1;
    function frame(now) {
        rafId = requestAnimationFrame(frame);
        if (session && appState === 'active' && !session.over) {
            if (session.lastTick != null) {
                session.activeMs += now - session.lastTick;
                session.lastTick = now;
            }
            const s = sessionElapsedSec();
            if (s !== hudSecond) { hudSecond = s; ui.refreshHud(); }
            const lim = session.entry.challenge;
            if (lim && lim.timeLimit && s >= lim.timeLimit && !session.over) endRound(false, N('Time ran out'));
        } else if (session) session.lastTick = now;
        pollGamepad();
        if (document.visibilityState === 'visible' && ['active', 'paused', 'resolving', 'results'].includes(appState)) {
            render.frame(now);
        }
    }

    window.addEventListener('resize', () => render.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => render.resize(), 60));

    // ================= language =================
    // Live switching (sh-language.js → PARKWISE_I18N): markup re-applies itself;
    // everything built in code re-renders here without touching the round.
    I.onChange(() => {
        if (captionKey) $('caption-line').textContent = T(captionKey);
        GFX_S = G.strings(G.pickLocale(I.lang()));
        SH_S = GFX_S.sh;
        labelAccountButtons();
        labelGraphicsPanel();
        syncGraphicsUi();
        Array.from(themeSel.options).forEach((o, i) => { o.textContent = T(C.THEMES[i].name); });
        renderKeyHelp();
        renderProfileLine();
        if (appState === 'mode-select') buildModeList();
        if (appState === 'preparing' && setupMode) openSetup(setupMode, true);
        if (session) ui.refreshAll();
        if (appState === 'results') renderResultsText();
    });

    // ================= boot =================
    function boot() {
        applySettingsToDom();
        themeSel.value = settings.theme || C.THEMES[0].id;
        if (C.TUTORIALS.every(t => progress.tutorialsDone.includes(t.id))) { /* tutorial replay available in settings */ }
        setAppState('title');
        render.resize();
        rafId = requestAnimationFrame(frame);
        renderProfileLine();
    }

    // tutorial completion tracking
    const _endRound = endRound;
    endRound = function (won, reason) {
        if (won && session && session.mode === 'learn' && !progress.tutorialsDone.includes(session.entry.id)) {
            progress.tutorialsDone.push(session.entry.id);
        }
        return _endRound(won, reason);
    };

    // public debug/verification API
    window.PARKWISE = {
        get session() { return session; },
        executeMove, undoMove, requestHint,
        startJourney, startLearn, startPractice, startChallenge, startDaily,
        rules: R, content: C,
        screenPosOfCell: (x, y) => render.screenPos(x, y),
        get appState() { return appState; },
    };

    // Hosted sessions start from the remote snapshot when one exists; bound the
    // handshake wait so a slow platform never blocks local play.
    Promise.race([initPlatform(), new Promise(res => setTimeout(res, 5000))]).finally(boot);
})();
