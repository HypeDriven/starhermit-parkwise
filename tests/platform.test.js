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
  const calls = [], saves = {}, kv = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    return r(404);
  };
  return { calls, saves, kv, fetch };
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
