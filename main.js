'use strict';

// Parkwise client: bootstrap / session / render / ui.
// Rules state is only mutated through validated commands; rendering consumes
// immutable snapshots; UI state never touches simulation state.
(function () {
    const THREE = window.THREE;
    const R = window.PARKWISE_RULES;
    const C = window.PARKWISE_CONTENT;
    const A = window.PARKWISE_AUDIO;

    const $ = id => document.getElementById(id);

    // ================= persistence =================
    const SETTINGS_KEY = 'parkwise.settings.v1';
    const PROGRESS_KEY = 'parkwise.progress.v1';

    const defaults = {
        volumes: { music: 0.6, effects: 0.8, ambience: 0.4, voice: 0.7 },
        muted: false, quality: 'medium', theme: null,
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

    const settings = Object.assign({}, defaults, loadJson(SETTINGS_KEY, {}));
    settings.volumes = Object.assign({}, defaults.volumes, settings.volumes);
    const progress = Object.assign({
        journeyUnlocked: 0, stars: {}, wins: 0, winStreak: 0,
        tutorialsDone: [], achievements: {}, dailiesDone: {}, lastDaily: null,
    }, loadJson(PROGRESS_KEY, {}));

    const ACHIEVEMENTS = {
        first_completion: 'First clear — solve your first lot',
        mechanic_mastery: 'Mechanic — solve a stage without undo or hints',
        streak_3: 'Regular — win three rounds in a row',
        milestone_hard: 'Rooftop veteran — clear a mastery stage',
        long_term: 'Commuter — 50 career wins',
    };
    function unlockAchievement(key) {
        if (progress.achievements[key]) return;
        progress.achievements[key] = Date.now();
        announce('Achievement unlocked: ' + ACHIEVEMENTS[key]);
        A.playSfx('win');
        saveProgress();
    }
    function saveSettings() { saveJson(SETTINGS_KEY, settings); }
    function saveProgress() { saveJson(PROGRESS_KEY, progress); }

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
    let captionTimer = null;
    A.onCaption(text => {
        if (!settings.captions) return;
        const el = $('caption-line');
        el.textContent = text;
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
        $('opt-quality').value = settings.quality;
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
            announce('Cannot move: ' + reason + '.');
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
        if (lim && lim.moveLimit && session.state.moves > lim.moveLimit) return endRound(false, 'Move limit reached');
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
            announce('Hints are disabled in this challenge.');
            A.playSfx('invalid');
            return;
        }
        const sol = R.solve(session.state);
        if (!sol || !sol.firstMove) { announce('No hint available.'); return; }
        session.hintsUsed++;
        session.hintShown = sol.firstMove;
        const v = session.state.vehicles[sol.firstMove.v];
        A.playSfx('hint');
        announce('Hint: try moving the ' + vehicleName(v) + ' ' + (sol.firstMove.dir > 0 ? (v.ori === 'h' ? 'right' : 'down') : (v.ori === 'h' ? 'left' : 'up')) + '.');
        render.highlightHint(sol.firstMove);
        ui.refreshHud();
    }

    function endRound(won, loseReason) {
        session.over = true;
        session.won = won;
        setAppState('resolving', won ? 'Solved!' : 'Round over');
        const secs = sessionElapsedSec();
        const sc = R.score({
            par: session.entry.par, moves: session.state.moves, seconds: secs,
            hints: session.hintsUsed, invalid: session.invalidCount,
            won, challenge: !!(session.entry.challenge),
        });
        session.finalScore = sc;
        if (won) {
            A.playSfx('win');
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
        setTimeout(() => showResults(won, sc, loseReason), settings.reducedMotion ? 200 : 900);
    }

    // ================= renderer (Three.js rooftop diorama) =================
    const CELL = 1.6;
    const render = (function () {
        const canvas = $('game-canvas');
        let renderer = null;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        } catch (e) {
            $('compat-message').style.display = 'block';
            $('compat-message').textContent = 'WebGL is unavailable. Parkwise needs 3D graphics; your progress is safe on this device.';
            return { buildBoard() {}, syncVehicles() {}, flashInvalid() {}, highlightHint() {}, select() {}, applyQuality() {}, applyTheme() {}, resetCamera() {}, resize() {}, frame() {}, pickCell() { return null; }, pickVehicle() { return -1; }, dispose() {} };
        }
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
        const CAM_HOME = { pos: new THREE.Vector3(0, 11.5, 10.5), look: new THREE.Vector3(0, 0, 0.4) };
        function resetCamera() { camera.position.copy(CAM_HOME.pos); camera.lookAt(CAM_HOME.look); }
        resetCamera();

        const hemi = new THREE.HemisphereLight(0xffffff, 0x333344, 0.85);
        scene.add(hemi);
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(8, 14, 6);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        const sc = 8;
        key.shadow.camera.left = -sc; key.shadow.camera.right = sc;
        key.shadow.camera.top = sc; key.shadow.camera.bottom = -sc;
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
        const avRng = R.rng(1234); // audiovisual variant stream (never rules)

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

        function makeVehicleMesh(v, isTarget, colorHex) {
            const grp = new THREE.Group();
            const L = v.len * CELL * 0.92, W = CELL * 0.72, H = 0.5;
            const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.45, metalness: 0.25 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(v.ori === 'h' ? L : W, H, v.ori === 'h' ? W : L), mat);
            body.position.y = H / 2 + 0.12;
            body.castShadow = true;
            grp.add(body);
            const cabMat = new THREE.MeshStandardMaterial({ color: 0x223044, roughness: 0.2, metalness: 0.4 });
            const cab = new THREE.Mesh(new THREE.BoxGeometry(v.ori === 'h' ? L * 0.42 : W * 0.8, 0.32, v.ori === 'h' ? W * 0.8 : L * 0.42), cabMat);
            cab.position.y = H + 0.28;
            grp.add(cab);
            const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 10);
            const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9 });
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
                const glowMat = new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.35, roughness: 0.4 });
                body.material = glowMat;
            }
            grp.layers.set(LAYER_GAME);
            grp.traverse(o => o.layers.set(LAYER_GAME));
            return grp;
        }

        function buildBoard(entry) {
            disposeGroup(boardGroup);
            vehicleViews = [];
            markerMeshes = [];
            boardGroup = new THREE.Group();
            scene.add(boardGroup);
            theme = C.THEMES.find(t => t.id === (settings.theme || entry.theme)) || C.THEMES[0];
            scene.background = new THREE.Color(theme.sky);
            scene.fog = new THREE.Fog(theme.fog, 24, 60);
            key.color.set(theme.key);

            const size = R.GRID * CELL;
            // rooftop slab
            const slab = new THREE.Mesh(new THREE.BoxGeometry(size + 4.4, 0.8, size + 4.4),
                new THREE.MeshStandardMaterial({ color: theme.slab, roughness: 0.95 }));
            slab.position.y = -0.4;
            slab.receiveShadow = true;
            boardGroup.add(slab);
            // parking surface
            const lot = new THREE.Mesh(new THREE.BoxGeometry(size + 0.5, 0.1, size + 0.5),
                new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 0.9 }));
            lot.position.y = 0.001;
            lot.receiveShadow = true;
            boardGroup.add(lot);
            // grid lines + cell markers (readable without effects)
            const lineMat = new THREE.MeshBasicMaterial({ color: theme.line });
            for (let i = 0; i <= R.GRID; i++) {
                const p = (i - R.GRID / 2) * CELL;
                const h = new THREE.Mesh(new THREE.BoxGeometry(size, 0.02, 0.045), lineMat);
                h.position.set(0, 0.06, p);
                const vl = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, size), lineMat);
                vl.position.set(p, 0.06, 0);
                boardGroup.add(h); boardGroup.add(vl);
            }
            // parapet walls with a gap at the exit
            const wallMat = new THREE.MeshStandardMaterial({ color: theme.parapet, roughness: 0.85 });
            const exZ = cellToWorld(0, R.EXIT_ROW).z;
            const mkWall = (w, d, x, z) => {
                const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), wallMat);
                m.position.set(x, 0.35, z);
                m.castShadow = true;
                boardGroup.add(m);
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
                new THREE.MeshStandardMaterial({ color: 0x2f9e6e, emissive: 0x2f9e6e, emissiveIntensity: 0.7 }));
            exitGate.position.set(half + 0.9, 0.08, exZ);
            boardGroup.add(exitGate);
            // seeded rooftop props: vents, AC boxes, antenna (visual seed deterministic)
            const deco = R.rng(entry.seed ^ 0xDEC0);
            const propMat = new THREE.MeshStandardMaterial({ color: 0x6b7686, roughness: 0.8, metalness: 0.3 });
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
                const color = v.target ? theme.target : theme.palette[(i - 1) % theme.palette.length];
                const mesh = makeVehicleMesh(v, v.target, color);
                mesh.userData.vehicleIndex = i;
                boardGroup.add(mesh);
                vehicleViews.push({ mesh, anim: null });
            });
            syncVehicles(false);
            applyQuality();
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
                if (animate && !settings.reducedMotion) {
                    view.anim = { from: view.mesh.position.clone(), to: new THREE.Vector3(p.x, 0, p.z), t: 0 };
                } else {
                    view.mesh.position.set(p.x, 0, p.z);
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
            view.shake = 0.25;
        }

        function highlightHint(move) {
            session.selected = move.v;
            updateSelectionVisual();
        }

        function spawnConfetti() {
            if (settings.reducedMotion || !boardGroup) return;
            const geo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
            for (let i = 0; i < 60; i++) {
                const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: theme.palette[i % theme.palette.length] }));
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
        function castAt(clientX, clientY, layer) {
            const r = canvas.getBoundingClientRect();
            ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
            raycaster.setFromCamera(ndc, camera);
            raycaster.layers.set(layer);
            const hits = raycaster.intersectObjects(boardGroup ? boardGroup.children : [], true);
            return hits[0] || null;
        }
        function pickVehicle(x, y) {
            const h = castAt(x, y, LAYER_GAME);
            if (!h) return -1;
            let o = h.object;
            while (o && o.userData.vehicleIndex === undefined) o = o.parent;
            return o ? o.userData.vehicleIndex : -1;
        }
        function pickMarker(x, y) {
            const h = castAt(x, y, LAYER_MARK);
            return h && h.object.userData.move ? h.object.userData.move : null;
        }
        function pickCell(x, y) { // for drag axis projection
            const h = castAt(x, y, LAYER_GAME);
            if (!h) return null;
            const wx = h.point.x / CELL + (R.GRID - 1) / 2;
            const wy = h.point.z / CELL + (R.GRID - 1) / 2;
            return { x: wx, y: wy };
        }

        function applyQuality() {
            const q = settings.quality;
            const dpr = window.devicePixelRatio || 1;
            renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.5) : 1);
            renderer.shadowMap.enabled = q !== 'low';
            key.castShadow = q !== 'low';
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            resize();
        }
        function applyTheme() { if (session) buildBoard(session.entry); }

        function resize() {
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (w > 0 && h > 0) {
                renderer.setSize(w, h, false);
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
            }
        }

        let last = performance.now();
        function frame(now) {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            for (const view of vehicleViews) {
                if (view.anim) {
                    view.anim.t += dt / 0.16;
                    if (view.anim.t >= 1) { view.mesh.position.copy(view.anim.to); view.anim = null; }
                    else {
                        const e = 1 - Math.pow(1 - view.anim.t, 3);
                        view.mesh.position.lerpVectors(view.anim.from, view.anim.to, e);
                    }
                }
                if (view.shake) {
                    view.shake -= dt;
                    view.mesh.position.x += Math.sin(now * 0.09) * 0.03 * Math.max(0, view.shake);
                    if (view.shake <= 0) view.shake = 0;
                }
            }
            for (let i = vfx.length - 1; i >= 0; i--) {
                const p = vfx[i];
                p.life -= dt;
                p.m.position.addScaledVector(p.m.userData.vel, dt);
                p.m.userData.vel.y -= 9.8 * dt;
                p.m.rotation.x += dt * 5; p.m.rotation.y += dt * 7;
                if (p.life <= 0) { boardGroup.remove(p.m); vfx.splice(i, 1); }
            }
            if (exitGate) exitGate.material.emissiveIntensity = 0.55 + Math.sin(now * 0.004) * 0.2;
            renderer.render(scene, camera);
        }

        function celebrate() { spawnConfetti(); }

        return { buildBoard, syncVehicles, flashInvalid, highlightHint, applyQuality, applyTheme, resetCamera, resize, frame, pickVehicle, pickMarker, pickCell, celebrate };
    })();

    // ================= UI =================
    function vehicleName(v) {
        return (v.target ? 'red car' : (v.ori === 'h' ? 'sideways' : 'upright') + ' ' + (v.len === 3 ? 'van' : 'car') + ' ' + v.id);
    }

    const ui = {
        refreshAll() { this.refreshHud(); this.refreshVehicleList(); this.refreshObjective(); },
        refreshHud() {
            if (!session) return;
            $('chip-mode').textContent = modeLabel(session.mode) + (session.entry.challenge ? ' · ' + session.entry.challenge.kind : '');
            $('chip-moves').textContent = 'Moves ' + session.state.moves + ' / par ' + session.entry.par;
            $('chip-time').textContent = formatTime(sessionElapsedSec());
            const lim = session.entry.challenge;
            const limChip = $('chip-limit');
            if (lim && lim.moveLimit) { limChip.hidden = false; limChip.textContent = 'Limit ' + lim.moveLimit; }
            else if (lim && lim.timeLimit) { limChip.hidden = false; limChip.textContent = 'Left ' + formatTime(Math.max(0, lim.timeLimit - sessionElapsedSec())); }
            else limChip.hidden = true;
            $('btn-undo').disabled = $('tray-undo').disabled = !session.history.length || session.over;
            $('btn-hint').disabled = $('tray-hint').disabled = session.over || (session.entry.challenge && session.entry.challenge.noHint);
        },
        refreshObjective() {
            if (!session) return;
            const blockers = R.exitBlockers(session.state);
            $('objective-desc').textContent = blockers.length
                ? 'Guide the red car to the glowing exit gate. ' + blockers.length + ' vehicle' + (blockers.length > 1 ? 's block' : ' blocks') + ' the lane.'
                : 'The lane is clear — drive the red car out!';
            $('progress-desc').textContent =
                'Mode: ' + modeLabel(session.mode) + ' · Stage par ' + session.entry.par +
                ' · Hints used ' + session.hintsUsed + ' · Wins ' + progress.wins +
                (session.entry.challenge ? ' · Constraint: ' + session.entry.challenge.kind : '');
            $('session-desc').textContent = 'Seed ' + session.entry.seed.toString(16) + ' · content v' + session.entry.version +
                ' · replay log ' + session.commands.length + ' commands';
        },
        refreshVehicleList() {
            if (!session) return;
            const ul = $('vehicle-list');
            ul.innerHTML = '';
            session.state.vehicles.forEach((v, i) => {
                const li = document.createElement('li');
                const b = document.createElement('button');
                b.textContent = vehicleName(v) + ' at column ' + (v.x + 1) + ', row ' + (v.y + 1) + (v.target ? ' (target)' : '');
                b.setAttribute('aria-pressed', i === session.selected ? 'true' : 'false');
                b.addEventListener('click', () => selectVehicle(i));
                li.appendChild(b);
                ul.appendChild(li);
            });
        },
    };

    function modeLabel(m) {
        return { learn: 'Learn', journey: 'Journey', daily: 'Daily', practice: 'Practice', challenge: 'Challenge', score: 'Score chase' }[m] || m;
    }
    function formatTime(s) {
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function selectVehicle(i) {
        if (!session || session.over) return;
        session.selected = i;
        A.playSfx('select');
        render.syncVehicles(false);
        ui.refreshVehicleList();
        announce(vehicleName(session.state.vehicles[i]) + ' selected.');
    }

    // ================= screens wiring =================
    const MODES = [
        { id: 'learn', title: 'Learn', desc: 'Interactive lessons — one rule at a time. Unranked.', ranked: false },
        { id: 'journey', title: 'Journey', desc: C.JOURNEY_COUNT + ' authored stages with mastery checks. Progress saved.', ranked: true },
        { id: 'daily', title: 'Daily', desc: 'One shared lot per UTC day. Ranked, validated on the server.', ranked: true },
        { id: 'practice', title: 'Practice', desc: 'Pick a difficulty, unlimited retry and undo. Unranked.', ranked: false },
        { id: 'challenge', title: 'Challenge', desc: 'Move limits, speed targets, restricted tools.', ranked: true },
        { id: 'score', title: 'Score chase', desc: 'Chase the leaderboard on fixed validated seeds.', ranked: true },
    ];

    function buildModeList() {
        const list = $('mode-list');
        list.innerHTML = '';
        for (const m of MODES) {
            const b = document.createElement('button');
            b.className = 'menu-item';
            b.setAttribute('role', 'listitem');
            let meta = m.ranked ? 'Ranked' : 'Unranked';
            if (m.id === 'journey') meta = 'Stage ' + (progress.journeyUnlocked + 1) + ' of ' + C.JOURNEY_COUNT;
            if (m.id === 'daily') meta = progress.lastDaily === todayKey() ? 'Done today' : 'New today';
            b.innerHTML = '<span><span class="title">' + m.title + '</span><br><span class="desc">' + m.desc + '</span></span><span class="meta">' + meta + '</span>';
            b.addEventListener('click', () => { A.playSfx('click'); openSetup(m.id); });
            list.appendChild(b);
        }
    }

    function openSetup(mode) {
        setAppState('preparing', modeLabel(mode) + ' setup');
        const list = $('setup-list');
        list.innerHTML = '';
        $('setup-h').textContent = modeLabel(mode);
        const info = {
            learn: 'Four short lessons. Expected 2–4 minutes. Unranked, undo allowed.',
            journey: 'Stages get denser and deeper; every tenth is a mastery stage. Ranked, undo and hints allowed with score penalties.',
            daily: 'Same lot for everyone this UTC day. Ranked; score is validated by the server from your replay log.',
            practice: 'Casual generated lots. Restart and undo freely; no rating impact.',
            challenge: 'Constraints apply — watch the HUD limit chip. Ranked.',
            score: 'Fixed seeds, asynchronous global and friends comparison. Ranked.',
        }[mode];
        $('setup-info').textContent = info;

        function addItem(label, meta, fn, disabled) {
            const b = document.createElement('button');
            b.className = 'menu-item';
            b.disabled = !!disabled;
            b.innerHTML = '<span class="title">' + label + '</span><span class="meta">' + (meta || '') + '</span>';
            b.addEventListener('click', () => { A.playSfx('click'); fn(); });
            list.appendChild(b);
        }

        if (mode === 'learn') {
            C.TUTORIALS.forEach((t, i) => addItem((i + 1) + '. ' + t.title, progress.tutorialsDone.includes(t.id) ? 'completed' : '', () => startLearn(i)));
        } else if (mode === 'journey') {
            for (let i = 0; i < C.JOURNEY_COUNT; i++) {
                const locked = i > progress.journeyUnlocked;
                const stars = progress.stars['journey-' + (i + 1)] || 0;
                addItem('Stage ' + (i + 1) + (C.difficultyFor(i).mastery ? ' · Mastery' : ''),
                    locked ? 'locked' : '★'.repeat(stars) || 'new', () => startJourney(i), locked);
            }
        } else if (mode === 'daily') {
            addItem('Today’s lot (' + todayKey() + ')', 'seed synchronized with server time', () => startDaily());
        } else if (mode === 'practice') {
            addItem('Easy', 'short solutions', () => startPractice(0));
            addItem('Medium', 'deeper planning', () => startPractice(1));
            addItem('Hard', 'dense lots', () => startPractice(2));
        } else if (mode === 'challenge') {
            for (let i = 0; i < 6; i++) {
                const e = C.challengeLevel(i);
                addItem('Challenge ' + (i + 1) + ' — ' + e.challenge.kind,
                    e.challenge.moveLimit ? 'move limit ' + e.challenge.moveLimit : e.challenge.timeLimit ? e.challenge.timeLimit + 's target' : 'no hints',
                    () => startChallenge(i));
            }
        } else if (mode === 'score') {
            for (let i = 0; i < 5; i++) addItem('Fixed seed ' + (i + 1), 'global board', () => startScore(i));
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
        beginRound('learn', entry, 'Lesson ' + (i + 1) + ': ' + t.title + '. ' + t.text);
        session.tutorialText = t.text;
        $('objective-desc').textContent = t.text;
    }
    function startJourney(i) { beginRound('journey', C.journeyLevel(i), 'Journey stage ' + (i + 1) + '.'); }
    function startPractice(tier) {
        const gen = C.practiceLevel(tier);
        const attempt = (session && session.practiceAttempt) || 0;
        beginRound('practice', gen(attempt), 'Practice round.');
        session.practiceTier = tier;
    }
    function startChallenge(i) { beginRound('challenge', C.challengeLevel(i), 'Challenge: ' + C.challengeLevel(i).challenge.kind + '.'); }
    function startScore(i) {
        const entry = C.journeyLevel(5 + i * 7);
        beginRound('score', entry, 'Score chase seed ' + (i + 1) + '.');
    }
    function startDaily() {
        const finish = day => beginRound('daily', C.dailyLevel(day), 'Daily challenge for ' + day + '.');
        // synchronize to platform time with round-trip adjustment; fall back to local UTC
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
        const first = $(id).querySelector('button, input, select');
        if (first) first.focus();
    }
    function closeOverlay(id) {
        $(id).classList.remove('active');
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }
    function closeAllOverlays() { document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active')); }

    function showResults(won, sc, loseReason) {
        setAppState('results');
        if (won) render.celebrate();
        $('results-h').textContent = won ? 'Lot cleared!' : 'Round over';
        $('results-headline').textContent = won
            ? 'Solved in ' + session.state.moves + ' moves and ' + formatTime(sessionElapsedSec()) + '.'
            : (loseReason || 'The lot stayed jammed.');
        const rows = [
            ['Completion base', sc.base], ['Move efficiency', sc.parBonus], ['Time bonus', sc.timeBonus],
            ['Hint penalty', sc.hintPenalty], ['Blocked-attempt penalty', sc.invalidPenalty],
            ['Challenge bonus', sc.challengeBonus],
        ];
        $('score-breakdown').innerHTML = rows.filter(r => r[1] !== 0).map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') +
            '<tr class="total"><td>Total</td><td>' + sc.total + '</td></tr>';
        $('results-progress').textContent = won
            ? 'Career wins: ' + progress.wins + ' · Journey stage ' + (progress.journeyUnlocked + 1) + ' unlocked'
            : 'Retry to keep your streak alive.';
        const ranked = ['journey', 'daily', 'score'].includes(session.mode) && won;
        $('submit-row').style.display = ranked ? '' : 'none';
        $('submit-status').textContent = '';
        $('leaderboard-table').innerHTML = '<tr><td>Loading…</td></tr>';
        refreshLeaderboard();
        const next = $('btn-next');
        next.style.display = won ? '' : 'none';
        openOverlay('overlay-results');
    }

    function refreshLeaderboard() {
        fetch('/api/v1/scores?board=global').then(r => r.json()).then(j => {
            const t = $('leaderboard-table');
            if (!j.entries || !j.entries.length) { t.innerHTML = '<tr><td>No validated scores yet — be the first.</td></tr>'; return; }
            t.innerHTML = '<tr><th>Name</th><th>Score</th><th>Moves</th><th>Time</th></tr>' + j.entries.slice(0, 10).map(e =>
                '<tr><td>' + e.name + '</td><td>' + e.score + '</td><td>' + e.moves + '</td><td>' + formatTime(e.seconds) + '</td></tr>').join('');
        }).catch(() => { $('leaderboard-table').innerHTML = '<tr><td>Leaderboard offline — playing locally.</td></tr>'; });
    }

    function submitScore() {
        if (!session || !session.won) return;
        const name = $('submit-name').value.trim() || 'Guest';
        const body = {
            name, mode: session.mode === 'score' ? 'score' : session.mode,
            day: session.entry.day || todayKey(),
            seed: session.entry.seed, contentVersion: session.entry.version,
            commands: session.commands, score: session.finalScore.total,
            seconds: sessionElapsedSec(), hints: session.hintsUsed, invalid: session.invalidCount,
        };
        $('submit-status').textContent = 'Validating…';
        fetch('/api/v1/scores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(async r => {
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || 'rejected');
                $('submit-status').textContent = 'Score accepted (validated server-side).';
                refreshLeaderboard();
            })
            .catch(e => { $('submit-status').textContent = 'Submit failed: ' + e.message; });
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
            drag = { id: e.pointerId, v: vi, sx: e.clientX, sy: e.clientY, moved: false };
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
        if (!cell) return;
        // project the drag onto the vehicle axis: toward the leading end or back from the tail
        const lead = v.ori === 'h' ? cell.x - v.x : cell.y - v.y;
        const headDelta = lead >= (v.len - 1) / 2
            ? (v.ori === 'h' ? cell.x - (v.x + v.len - 1) : cell.y - (v.y + v.len - 1))
            : lead;
        const cells2 = Math.round(headDelta);
        if (cells2 !== 0) executeMove(d.v, Math.sign(cells2), Math.abs(cells2), 'd' + e.pointerId + '-' + Date.now());
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });

    // ================= input: keyboard =================
    document.addEventListener('keydown', e => {
        if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.key === 'Escape') {
            if ($('overlay-settings').classList.contains('active')) return closeOverlay('overlay-settings');
            if ($('overlay-help').classList.contains('active')) return closeOverlay('overlay-help');
            if (appState === 'active') return pauseGame();
            if (appState === 'paused') return resumeGame();
            return;
        }
        if (appState !== 'active' || !session || session.over) return;
        const k = e.key;
        if (k === 'Tab') {
            e.preventDefault();
            const n = session.state.vehicles.length;
            selectVehicle((session.selected + (e.shiftKey ? n - 1 : 1)) % n);
        } else if (k.startsWith('Arrow')) {
            e.preventDefault();
            const v = session.state.vehicles[session.selected];
            const map = v.ori === 'h' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
            if (map[k] !== undefined) executeMove(session.selected, map[k], 1, 'k' + (++cmdCounter));
            else { A.playSfx('invalid'); announce('That vehicle only moves ' + (v.ori === 'h' ? 'left and right' : 'up and down') + '.'); }
        } else if (k === 'u' || k === 'U') undoMove();
        else if (k === 'h' || k === 'H') requestHint();
        else if (k === 'r' || k === 'R') restartRound();
        else if (k === 'c' || k === 'C') render.resetCamera();
        else if (k === 'p' || k === 'P') pauseGame();
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
        setAppState('paused', 'Paused.');
        A.playSfx('pause');
        A.suspendAll();
        openOverlay('overlay-pause');
    }
    function resumeGame() {
        closeAllOverlays();
        setAppState('active', 'Resumed.');
        A.startMusic();
        A.startAmbience();
        session.lastTick = performance.now();
    }
    function restartRound() {
        if (!session) return;
        if (session.mode === 'practice') session.practiceAttempt = session.practiceAttempt || 0;
        beginRound(session.mode, session.entry, 'Round restarted.');
    }
    function leaveRound() {
        closeAllOverlays();
        A.suspendAll();
        session = null;
        setAppState('mode-select', 'Choose a mode.');
        buildModeList();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && appState === 'active') pauseGame();
    });

    // ================= buttons =================
    function on(id, fn) { $(id).addEventListener('click', () => { A.playSfx('click'); fn(); }); }
    on('btn-play', () => { buildModeList(); setAppState('mode-select', 'Choose a mode.'); });
    on('btn-daily', () => startDaily());
    on('btn-journey-resume', () => startJourney(progress.journeyUnlocked));
    on('btn-settings', () => openOverlay('overlay-settings'));
    on('btn-help', () => openOverlay('overlay-help'));
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
    on('btn-rail-left', () => { $('rail-left').classList.toggle('open'); });
    on('btn-rail-right', () => { $('rail-right').classList.toggle('open'); });

    // settings controls
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
        $('vol-' + bus).addEventListener('input', e => {
            settings.volumes[bus] = e.target.value / 100;
            A.setVolume(bus, settings.volumes[bus]);
            saveSettings();
        });
    }
    $('opt-mute').addEventListener('change', e => { settings.muted = e.target.checked; A.setMuted(settings.muted); saveSettings(); });
    $('opt-quality').addEventListener('change', e => { settings.quality = e.target.value; render.applyQuality(); saveSettings(); });
    const themeSel = $('opt-theme');
    C.THEMES.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; themeSel.appendChild(o); });
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
            if (lim && lim.timeLimit && s >= lim.timeLimit && !session.over) endRound(false, 'Time ran out');
        } else if (session) session.lastTick = now;
        pollGamepad();
        if (document.visibilityState === 'visible' && ['active', 'paused', 'resolving', 'results'].includes(appState)) {
            render.frame(now);
        }
    }

    window.addEventListener('resize', () => render.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => render.resize(), 60));

    // ================= boot =================
    function boot() {
        applySettingsToDom();
        themeSel.value = settings.theme || C.THEMES[0].id;
        if (C.TUTORIALS.every(t => progress.tutorialsDone.includes(t.id))) { /* tutorial replay available in settings */ }
        setAppState('title');
        render.resize();
        rafId = requestAnimationFrame(frame);
        // mark tutorials complete when their lessons are won
        const origEnd = endRound;
        // host handshake: probe platform time once (graceful offline)
        fetch('/api/v1/time').then(r => r.json()).then(() => { $('profile-line').textContent = 'Guest profile — connected to host for daily sync and leaderboards.'; }).catch(() => {});
    }

    // tutorial completion tracking
    const _endRound = endRound;
    endRound = function (won, reason) {
        if (won && session && session.mode === 'learn' && !progress.tutorialsDone.includes(session.entry.id)) {
            progress.tutorialsDone.push(session.entry.id);
        }
        _endRound(won, reason);
    };

    // public debug/verification API
    window.PARKWISE = {
        get session() { return session; },
        executeMove, undoMove, requestHint,
        startJourney, startLearn, startPractice, startChallenge, startDaily,
        rules: R, content: C,
        get appState() { return appState; },
    };

    boot();
})();
