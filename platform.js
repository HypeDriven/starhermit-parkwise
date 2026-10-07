'use strict';

// Parkwise StarHermit platform adapter (browser only) over the shared SDK
// (starhermit-sdk.js, loaded by index.html as window.StarHermit).
// - The SDK reads the launch token (#game_token / #access_token), strips it,
//   renews it before expiry and signs out when renewal is refused.
// - Account display name from the profile (nickname, never /api/v1/me);
//   "Player " + id prefix fallback.
// - Mirrors the settings+progress doc into the `game:<slug>` cloud-save slot
//   (remote-preferred on load); localStorage stays the offline cache.
// - Per-player settings KV, keyboard bindings, sign-in and the invite link.
// - Hosted leaderboards are read-only (the game's first platform board).
// When no token was read the game stays in local mode and never calls the API.
(function (root, factory) {
    const api = factory(root);
    root.PARKWISE_PLATFORM = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
    const SH = root.StarHermit || null;
    if (SH) SH.init();
    const isHosted = () => !!(SH && SH.signedIn && SH.slug);

    function fallbackName(userId) {
        return 'Player ' + String(userId || 'unknown').slice(0, 6);
    }
    async function displayName(userId) {
        if (!isHosted() || !userId) return fallbackName(userId);
        const p = await SH.profile(String(userId));
        return p ? p.displayName : fallbackName(userId);
    }

    // ---- cloud save: one doc in the `game:<slug>` slot ----
    let statusCb = null;
    function setStatus(s) { if (statusCb) statusCb(s); }

    async function cloudLoad() {
        if (!isHosted()) return null;
        return SH.loadJSON(); // null when no save yet / unreachable
    }

    let docProvider = null, dirtyTimer = null, pushing = false, repush = false;
    function cloudStart(provider) { docProvider = provider; }

    function cloudDirty() {
        if (!isHosted() || !docProvider) return;
        setStatus('saving');
        clearTimeout(dirtyTimer);
        dirtyTimer = setTimeout(() => cloudPush(false), 2000); // debounce ~2 s
    }

    async function cloudPush(keepalive) {
        if (!docProvider || !isHosted()) return;
        if (pushing) { repush = true; return; }
        pushing = true;
        try {
            const ok = await SH.writeSave(JSON.stringify(docProvider()), { keepalive });
            setStatus(ok ? 'synced' : 'offline');
        } finally {
            pushing = false;
            if (repush) { repush = false; cloudPush(false); }
        }
    }

    function cloudFlush() {
        clearTimeout(dirtyTimer);
        if (!isHosted() || !docProvider) return;
        cloudPush(true); // keepalive so the PUT survives pagehide
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', cloudFlush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') cloudFlush();
        });
    }

    // ---- read-only hosted leaderboard (first platform board) ----
    async function leaderboardRows(pageSize) {
        if (!isHosted()) return null;
        const res = await SH.leaderboard(null, { pageSize: pageSize || 10 });
        if (!res || !res.board) return null;
        return Promise.all((res.items || []).map(async (e, i) => ({
            rank: e.rank != null ? e.rank : i + 1,
            name: await displayName(e.userId),
            score: e.score,
        })));
    }

    // ---- leaderboard posting (score-script.js) ----
    // A won ranked round's total goes through submitScores to the high-score
    // board; resolves { posted, rank } (rank or null). No request standalone.
    async function submitScore(total) {
        if (!isHosted()) return { posted: false, rank: null };
        let keys = [];
        try { keys = await SH.submitScores({ 'high-score': total }); } catch (e) { keys = []; }
        if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
        try {
            const r = await SH.leaderboard('high-score', { pageSize: 100 });
            const me = ((r && r.items) || []).find(i => i.userId === SH.userId);
            return { posted: true, rank: me ? me.rank : null };
        } catch (e) { return { posted: true, rank: null }; }
    }

    // ---- settings KV, bindings, sign-in, invite ----
    async function getSettings() { return isHosted() ? SH.getSettings() : null; }
    function patchSettings(obj) { if (isHosted()) SH.patchSettings(obj); }
    async function loadBindings(defaults) {
        const copy = JSON.parse(JSON.stringify(defaults));
        if (!isHosted()) return copy;
        try { return await SH.loadBindings(defaults); } catch (e) { return copy; }
    }
    function onAuth(cb) {
        if (!SH) return;
        let was = isHosted();
        SH.on('auth', (a) => {
            if (a.signedIn === was) return; // renewals change nothing visible
            was = a.signedIn;
            cb(a);
        });
    }

    return {
        get hosted() { return isHosted(); },
        fallbackName,
        get sub() { return isHosted() ? SH.userId : null; },
        get slug() { return SH ? SH.slug : null; },
        onStatus(cb) { statusCb = cb; },
        displayName,
        myDisplayName() { return displayName(SH && SH.userId); },
        avatarUrl() { return isHosted() ? SH.avatarUrl() : Promise.resolve(null); },
        cloudStart, cloudDirty, cloudFlush, cloudLoad,
        leaderboardRows, submitScore,
        getSettings, patchSettings, loadBindings, onAuth,
        canSignIn() { return !!(SH && SH.canSignIn()); },
        signIn() { return !!(SH && SH.signIn()); },
        inviteLink() { return isHosted() ? SH.inviteLink() : null; },
    };
});
