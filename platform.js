'use strict';

// Parkwise StarHermit platform adapter (browser only).
// - Reads the launch token from the URL fragment (#game_token=<jwt>), strips it,
//   and sends Authorization: Bearer on every same-origin /api call.
// - Re-mints the token every 45 min via POST /api/v1/games/{slug}/launch-token.
// - Fetches the account display name via GET /api/v1/users/{sub}/profile
//   (never /api/v1/me, never usernames); "Player " + id.slice(0,8) fallback.
// - Mirrors the settings+progress doc into the platform cloud-save slot
//   (zip+base64, remote-preferred on load); localStorage stays the offline cache.
// - Hosted leaderboards are read-only: GET /api/v1/games/{slug} → leaderboardId,
//   then GET /api/v1/leaderboards/{id}/entries with display-name resolution.
// When no token was read the game stays in local mode and never calls the API.
(function (root, factory) {
    const api = factory();
    root.PARKWISE_PLATFORM = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

    // ---- launch token: fragment first, read once, then stripped ----
    function readTokenOnce() {
        if (location.hash.length > 1) {
            const params = new URLSearchParams(location.hash.slice(1));
            const tok = params.get('game_token');
            if (tok) {
                try {
                    const kept = new URLSearchParams(params);
                    kept.delete('game_token');
                    const rest = kept.toString();
                    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
                } catch (e) { /* sandboxed frame: the token still works for this session */ }
                return tok;
            }
        }
        // query-string fallbacks are for local dev on the game's own server only
        if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
            const q = new URLSearchParams(location.search);
            return q.get('game_token') || q.get('launch') || q.get('token');
        }
        return null;
    }

    function decodeJwtPayload(tok) {
        try {
            const part = tok.split('.')[1];
            const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
            const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) { return {}; }
    }

    let token = readTokenOnce();
    const payload = token ? decodeJwtPayload(token) : {};
    const sub = payload.sub || null;
    const slug = payload.game_scope || null; // never hard-code the game slug
    const hosted = !!token;

    // ---- minimal ZIP writer/reader (stored entries only, no compression) ----
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function zipStore(name, dataBytes) {
        const enc = new TextEncoder();
        const nameB = enc.encode(name);
        const crc = crc32(dataBytes);
        const out = [];
        const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
        const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
        u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
        u32(crc); u32(dataBytes.length); u32(dataBytes.length);
        u16(nameB.length); u16(0);
        const local = out.length;
        const head = new Uint8Array(out);
        const cd = [];
        const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
        const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
        c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
        c32(crc); c32(dataBytes.length); c32(dataBytes.length);
        c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
        const cdHead = new Uint8Array(cd);
        const cdOff = head.length + nameB.length + dataBytes.length;
        const parts = [head, nameB, dataBytes, cdHead, nameB];
        const eocd = [];
        const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
        const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
        e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
        e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
        parts.push(new Uint8Array(eocd));
        const total = parts.reduce((n, p) => n + p.length, 0);
        const buf = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { buf.set(p, o); o += p.length; }
        return buf;
    }
    function unzipFirstEntry(zipBytes) {
        // Stored single-entry reader: scan local headers for compression 0.
        const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
        let off = 0;
        while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
            const method = dv.getUint16(off + 8, true);
            const size = dv.getUint32(off + 18, true);
            const nameLen = dv.getUint16(off + 26, true);
            const extraLen = dv.getUint16(off + 28, true);
            const dataOff = off + 30 + nameLen + extraLen;
            if (method !== 0) throw new Error('unsupported zip entry');
            return zipBytes.slice(dataOff, dataOff + size);
        }
        throw new Error('bad zip');
    }
    function bytesToBase64(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }
    function base64ToBytes(b64) {
        const s = atob(b64);
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        return b;
    }

    // ---- authenticated REST (Bearer on every call) ----
    async function api(path, opts = {}) {
        const headers = Object.assign({}, opts.headers, { authorization: 'Bearer ' + token });
        if (opts.body) headers['content-type'] = 'application/json';
        const res = await fetch(path, {
            method: opts.method || 'GET', headers,
            body: opts.body, keepalive: !!opts.keepalive,
        });
        if (opts.raw) return res;
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        return j;
    }

    // ---- token refresh: scoped launch tokens may re-mint; 45 min cadence ----
    const REFRESH_MS = 45 * 60 * 1000;
    const REFRESH_RETRY_MS = 60 * 1000;
    let refreshTimer = null;
    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshToken, REFRESH_MS);
    }
    async function refreshToken() {
        if (!hosted || !slug) return;
        try {
            const j = await api('/api/v1/games/' + slug + '/launch-token', { method: 'POST' });
            if (j && j.token) token = j.token;
        } catch (e) {
            refreshTimer = setTimeout(refreshToken, REFRESH_RETRY_MS);
            return;
        }
        scheduleRefresh();
    }
    if (hosted && slug) scheduleRefresh();

    // ---- display names: nickname only, never usernames, never /api/v1/me ----
    const nameCache = new Map();
    function fallbackName(userId) {
        return 'Player ' + String(userId || 'unknown').slice(0, 8);
    }
    async function displayName(userId) {
        if (!hosted || !userId) return fallbackName(userId);
        if (nameCache.has(userId)) return nameCache.get(userId);
        const name = await api('/api/v1/users/' + userId + '/profile')
            .then(j => (j && j.nickname) ? j.nickname : fallbackName(userId))
            .catch(() => fallbackName(userId));
        nameCache.set(userId, name);
        return name;
    }

    // ---- cloud save: one zip+base64 doc; localStorage stays the offline cache ----
    const SAVE_ENTRY = 'parkwise-save.json';
    let statusCb = null;
    function setStatus(s) { if (statusCb) statusCb(s); }

    async function cloudLoad() {
        if (!hosted || !slug) return null;
        const res = await api('/api/v1/me/cloud-saves/' + slug, { raw: true });
        if (res.status === 404) return null; // no save yet
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    }

    async function cloudPushDoc(doc, keepalive) {
        if (!hosted || !slug) return;
        const bytes = new TextEncoder().encode(JSON.stringify(doc));
        const body = JSON.stringify({ dataBase64: bytesToBase64(zipStore(SAVE_ENTRY, bytes)) });
        await api('/api/v1/me/cloud-saves/' + slug, { method: 'PUT', body, keepalive });
    }

    let docProvider = null, dirtyTimer = null, pushing = false, repush = false;
    function cloudStart(provider) { docProvider = provider; }

    function cloudDirty() {
        if (!hosted || !slug || !docProvider) return;
        setStatus('saving');
        clearTimeout(dirtyTimer);
        dirtyTimer = setTimeout(() => cloudPush(false), 2000); // debounce ~2 s
    }

    async function cloudPush(keepalive) {
        if (!docProvider) return;
        if (pushing) { repush = true; return; }
        pushing = true;
        try {
            await cloudPushDoc(docProvider(), keepalive);
            setStatus('synced');
        } catch (e) {
            setStatus('offline');
        } finally {
            pushing = false;
            if (repush) { repush = false; cloudPush(false); }
        }
    }

    function cloudFlush() {
        clearTimeout(dirtyTimer);
        if (!hosted || !slug || !docProvider) return;
        cloudPush(true); // keepalive so the PUT survives pagehide
    }
    window.addEventListener('pagehide', cloudFlush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') cloudFlush();
    });

    // ---- read-only hosted leaderboards ----
    async function gameInfo() {
        if (!hosted || !slug) return null;
        const res = await api('/api/v1/games/' + slug, { raw: true });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function leaderboardEntries(leaderboardId, opts = {}) {
        const q = new URLSearchParams({
            friendsOnly: opts.friendsOnly ? '1' : '',
            page: String(opts.page || 0),
            pageSize: String(opts.pageSize || 10),
        });
        const j = await api('/api/v1/leaderboards/' + leaderboardId + '/entries?' + q);
        const entries = j.entries || [];
        return Promise.all(entries.map(async (e, i) => ({
            rank: e.rank != null ? e.rank : i + 1,
            name: await displayName(e.userId),
            score: e.score,
        })));
    }

    return {
        hosted, fallbackName,
        get token() { return token; },
        get sub() { return sub; },
        get slug() { return slug; },
        api,
        onStatus(cb) { statusCb = cb; },
        displayName,
        myDisplayName() { return displayName(sub); },
        cloudStart, cloudDirty, cloudFlush, cloudLoad,
        gameInfo, leaderboardEntries,
        // exposed for validation harnesses
        _zip: { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes },
    };
});
