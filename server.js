'use strict';

// Parkwise authoritative server (StarHermit game script).
// - Serves the static distribution from this directory.
// - GET  /healthz
// - GET  /api/v1/time            platform time for countdown/daily sync
// - GET  /api/v1/daily           today's immutable daily seed + content version
// - GET  /api/v1/scores?board=   leaderboard (global; friends filter client-side)
// - POST /api/v1/scores          validated score submission (replay re-executed)
// Competitive claims are untrusted: every submission is re-simulated from its
// ordered input log through the shared rules engine before acceptance.
const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./rules.js');
const C = require('./content.js');

const PORT = process.env.PORT ? +process.env.PORT : 8090;
const ROOT = __dirname;
const SCORES_FILE = process.env.PARKWISE_SCORES_FILE || path.join(ROOT, 'scores.json');
const MAX_BODY = 64 * 1024;
const MAX_COMMANDS = 2000;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
    '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.opus': 'audio/ogg',
};

function dayKeyUTC(now) {
    const d = new Date(now);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function loadScores() {
    try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); }
    catch (e) { return { version: 1, entries: [] }; }
}
function saveScores(db) {
    fs.writeFileSync(SCORES_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(SCORES_FILE + '.tmp', SCORES_FILE);
}

// Resolve the content entry a submission claims to have played.
function resolveContent(mode, seed, day) {
    try {
        if (mode === 'daily') {
            const e = C.dailyLevel(day);
            return e.seed === seed ? e : null;
        }
        if (mode === 'journey' || mode === 'score') {
            for (let i = 0; i < C.JOURNEY_COUNT; i++) {
                const e = C.journeyLevel(i);
                if (e.seed === seed) return e;
            }
        }
    } catch (e) { /* fall through */ }
    return null;
}

// Authoritative validation: replay the input log, recompute the score.
function validateSubmission(sub) {
    if (!sub || typeof sub !== 'object') return 'malformed body';
    if (typeof sub.name !== 'string' || sub.name.length < 1 || sub.name.length > 24) return 'bad name';
    if (!['daily', 'journey', 'score'].includes(sub.mode)) return 'unsupported mode';
    if (!Number.isInteger(sub.seed)) return 'bad seed';
    if (!Array.isArray(sub.commands) || sub.commands.length > MAX_COMMANDS) return 'bad command log';
    for (const c of sub.commands) {
        if (!c || c.type !== 'move' || !Number.isInteger(c.v) || (c.dir !== -1 && c.dir !== 1) || !Number.isInteger(c.dist)) return 'bad command';
    }
    const entry = resolveContent(sub.mode, sub.seed, sub.day);
    if (!entry) return 'unknown seed or stale content version';
    if (entry.version !== sub.contentVersion) return 'stale content version';
    const out = R.replay(entry.level, sub.commands);
    if (!out.ok) return 'illegal command log: ' + out.error;
    if (!R.isWin(out.state)) return 'run did not finish the objective';
    const seconds = Math.max(0, Math.min(3600, sub.seconds | 0));
    const hints = Math.max(0, Math.min(50, sub.hints | 0));
    const invalid = Math.max(0, Math.min(500, sub.invalid | 0));
    const sc = R.score({ par: entry.par, moves: sub.commands.length, seconds, hints, invalid, won: true, challenge: false });
    if (sc.total !== sub.score) return 'score mismatch: expected ' + sc.total + ', got ' + sub.score;
    return { entry, score: sc, seconds };
}

function handleApi(req, res, url) {
    if (url.pathname === '/api/v1/time') {
        return sendJson(res, 200, { now: Date.now() });
    }
    if (url.pathname === '/api/v1/daily') {
        const day = dayKeyUTC(Date.now());
        return sendJson(res, 200, { day, seed: parseInt(C.dailySeed(day), 16), contentVersion: C.CONTENT_VERSION });
    }
    if (url.pathname === '/api/v1/scores' && req.method === 'GET') {
        const board = url.searchParams.get('board') || 'global';
        const db = loadScores();
        const entries = db.entries
            .filter(e => board === 'global' || e.board === board)
            .filter(e => ['mode', 'seed', 'day', 'contentVersion'].every(key =>
                !url.searchParams.has(key) || String(e[key]) === url.searchParams.get(key)))
            .sort((a, b) => b.score - a.score || a.seconds - b.seconds || (a.id < b.id ? -1 : 1))
            .slice(0, 50);
        return sendJson(res, 200, { board, entries });
    }
    if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
        let body = '';
        let aborted = false;
        req.on('data', chunk => {
            if (aborted) return;
            body += chunk;
            if (body.length > MAX_BODY) { // answer before hanging up, so the client shows a reason
                aborted = true;
                sendJson(res, 413, { error: 'submission too large' });
                req.destroy();
            }
        });
        req.on('end', () => {
            if (aborted) return;
            let sub;
            try { sub = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'malformed json' }); }
            const verdict = validateSubmission(sub);
            if (typeof verdict === 'string') return sendJson(res, 422, { error: verdict });
            const db = loadScores();
            const record = {
                id: R.hash(JSON.stringify(sub) + Date.now()),
                name: sub.name.replace(/[<>&"]/g, ''),
                board: sub.board === 'friends' ? 'friends' : 'global',
                mode: sub.mode, day: sub.day || null,
                seed: sub.seed, contentVersion: sub.contentVersion,
                ruleset: 'parkwise-' + R.SCHEMA_VERSION,
                score: verdict.score.total, components: verdict.score,
                moves: sub.commands.length, seconds: verdict.seconds,
                assists: { hints: sub.hints | 0 },
                at: new Date().toISOString(),
            };
            db.entries.push(record);
            saveScores(db);
            return sendJson(res, 201, { ok: true, id: record.id, score: record.score });
        });
        req.on('error', () => { if (!aborted && !res.headersSent) sendJson(res, 400, { error: 'request failed' }); });
        return;
    }
    return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

    // static files; stay inside ROOT
    let rel;
    try { // a malformed percent-escape must not take the server down
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    } catch (e) { res.writeHead(400); return res.end('bad request'); }
    const p = path.normalize(path.join(ROOT, rel));
    // ROOT itself, or a path below it — plain startsWith would also accept a
    // sibling directory whose name merely begins with ROOT.
    if ((p !== ROOT && !p.startsWith(ROOT + path.sep)) || p.includes('scores.json')) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(p, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });
});

server.listen(PORT, () => console.log('parkwise server on http://localhost:' + server.address().port));
