'use strict';
/* Parkwise — platform adapter over the shared StarHermit SDK: launch token,
 * profile name, game:<slug> cloud-save round-trip, settings KV, controls, and
 * no network at all when standalone. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SDK = require('../starhermit-sdk.js');
const PLATFORM = path.join(__dirname, '../platform.js');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = 'h.' + b64u({ sub: 'user-123456', game_scope: 'pw-slug', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
// SDK renewal timers must not keep the test process alive.
const unrefTimeout = (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; };

function fakeServer() {
  const calls = [], saves = {}, kv = {}, etags = {};
  let version = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      // Conditional writes like the platform: If-Match / If-None-Match after a
      // load, 412 with the current etag when stale, { etag } on success.
      const tail = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = tail.replace(/\/info$/, '');
      const h = new Headers(init.headers || {});
      if (tail.endsWith('/info')) return r(200, JSON.stringify(saves[key] ? { exists: true, etag: etags[key] } : { exists: false }));
      if (method === 'PUT') {
        if ((h.get('If-Match') && h.get('If-Match') !== etags[key]) || (h.get('If-None-Match') === '*' && saves[key])) return r(412, JSON.stringify({ etag: etags[key] || null }));
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = '"v' + (++version) + '"';
        return r(200, JSON.stringify({ etag: etags[key] }));
      }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    return r(404);
  };
  return { calls, saves, kv, etags, fetch, bump(key) { etags[key] = '"v' + (++version) + '"'; } };
}

// Load platform.js fresh into a fake browser global.
function loadPlatform(hash, srv, hostname) {
  const win = {
    location: { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: 'https://' + hostname + '/' },
    history: { replaceState() {} },
    addEventListener() {},
  };
  win.StarHermit = SDK.create({ window: win, fetch: srv.fetch, setTimeout: unrefTimeout });
  global.self = win; global.window = win; global.document = { addEventListener() {} };
  global.fetch = srv.fetch; // any direct request is counted too
  delete require.cache[PLATFORM];
  require(PLATFORM);
  delete global.self;
  return win;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

test('hosted: token, profile, cloud save game:<slug>, settings KV, controls', async () => {
  const srv = fakeServer();
  const win = loadPlatform('#game_token=' + token, srv, 'pw-slug.starhermit.com');
  const P = win.PARKWISE_PLATFORM;
  assert.equal(P.hosted, true);
  assert.equal(P.sub, 'user-123456');
  assert.equal(P.slug, 'pw-slug');
  assert.equal(await P.myDisplayName(), 'Tess');

  let status = null;
  P.onStatus((s) => { status = s; });
  P.cloudStart(() => ({ savedAt: 1, settings: { muted: true }, progress: { wins: 2 } }));
  P.cloudFlush();
  await tick();
  assert.equal(status, 'synced');
  assert.deepEqual(Object.keys(srv.saves), ['game:pw-slug']);
  assert.deepEqual(await P.cloudLoad(), { savedAt: 1, settings: { muted: true }, progress: { wins: 2 } });

  P.patchSettings({ muted: true });
  await tick();
  assert.equal(srv.kv.muted, true);
  assert.deepEqual(await P.getSettings(), { muted: true });

  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['KeyJ'], undo: ['KeyU'] });
  assert.ok(P.inviteLink().endsWith('/game-invite/user-123456/pw-slug'));
  assert.equal(P.canSignIn(), false);
});

test('standalone: no token means no fetch at all', async () => {
  const srv = fakeServer();
  const win = loadPlatform('', srv, 'localhost');
  const P = win.PARKWISE_PLATFORM;
  assert.equal(P.hosted, false);
  assert.equal(await P.myDisplayName(), 'Player unknow');
  P.cloudStart(() => ({ v: 1 }));
  P.cloudDirty();
  P.cloudFlush();
  assert.equal(await P.cloudLoad(), null);
  P.patchSettings({ muted: true });
  assert.equal(await P.getSettings(), null);
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(await P.leaderboardRows(10), null);
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  await tick();
  assert.equal(srv.calls.length, 0);
});

test('sign-in is offered on a StarHermit UUID host without a token', () => {
  const srv = fakeServer();
  const win = loadPlatform('', srv, '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com');
  assert.equal(win.PARKWISE_PLATFORM.canSignIn(), true);
});

test('cloud-save conflict: a write that lost to another device is reported, re-read and merged', async () => {
  const srv = fakeServer();
  const win = loadPlatform('#game_token=' + token, srv, 'pw-slug.starhermit.com');
  const P = win.PARKWISE_PLATFORM;
  let doc = { savedAt: 1, settings: {}, progress: { wins: 1, journeyUnlocked: 2, stars: { 'j-1': 2 } } };
  P.cloudStart(() => doc);
  P.cloudFlush();
  await tick();
  await P.cloudLoad(); // writes are conditional on this version from now on
  // Another device saves a newer document.
  const other = { savedAt: 2, settings: {}, progress: { wins: 6, journeyUnlocked: 5, stars: { 'j-1': 1, 'j-4': 3 }, achievements: { first: 100 } } };
  srv.saves['game:pw-slug'] = Buffer.from(await win.StarHermit._zip('save.json', new TextEncoder().encode(JSON.stringify(other))));
  srv.bump('game:pw-slug');
  let conflicts = 0;
  P.onSaveConflict(() => { conflicts++; });
  doc = { savedAt: 3, settings: {}, progress: { wins: 2, journeyUnlocked: 3, stars: { 'j-1': 3 }, tutorialsDone: ['t1'], achievements: { first: 50 } } };
  P.cloudFlush();
  await tick();
  assert.equal(conflicts, 1);
  const remote = await P.cloudLoad();
  assert.equal(remote.progress.wins, 6); // the other device's write survived
  const merged = P.mergeProgress(remote.progress, doc.progress);
  assert.equal(merged.wins, 6);
  assert.equal(merged.journeyUnlocked, 5);
  assert.deepEqual(merged.stars, { 'j-1': 3, 'j-4': 3 });
  assert.deepEqual(merged.tutorialsDone, ['t1']);
  assert.equal(merged.achievements.first, 50); // earliest unlock time
  doc = { savedAt: 4, settings: {}, progress: merged };
  P.cloudFlush();
  await tick();
  const back = await P.cloudLoad();
  assert.equal(back.progress.wins, 6);
  assert.deepEqual(back.progress.tutorialsDone, ['t1']);
});
