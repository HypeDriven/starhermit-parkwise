/**
 * Parkwise — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings/help overlays → mode select → Journey stage 1 →
 * pause/resume → hint/undo → full keyboard solve (guided by the exposed
 * rules solver for timing/choice only; every move goes through real key
 * presses) → results → Next stage → pause → leave.
 *
 * Two passes: desktop 1280x800, then a fresh mobile context 390x844 with
 * touch. Fails loudly on any non-benign console error / pageerror.
 *
 * The repo's server.js is a StarHermit authoritative game script, so this
 * test embeds its own static file server on an ephemeral port. Minimal
 * /api/v1 stubs (time, daily, scores) are included so the client's online
 * code paths run without 404 console noise; the game is fully playable
 * offline regardless (it falls back gracefully when these are absent).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'text/plain', '.txt': 'text/plain',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  // minimal platform API stubs so online code paths succeed offline
  if (url.pathname === '/api/v1/time') return sendJson(res, 200, { now: Date.now() });
  if (url.pathname === '/api/v1/daily') return sendJson(res, 200, { day: 'e2e', seed: 0, contentVersion: 0 });
  if (url.pathname === '/api/v1/scores') return sendJson(res, 200, { board: 'global', entries: [] });

  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; }
  catch (e) { res.writeHead(400); return res.end('bad request'); }
  const p = path.normalize(path.join(ROOT, rel));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
});

const errors = [];
const SHOT = (stage, pass) => `/tmp/parkwise-e2e-${stage}-${pass}.png`;

async function playthrough(page, pass) {
  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${pass}] ${name}`);
  };

  const parkwise = (fn) => page.evaluate(fn);

  await step('load + title visible', async () => {
    await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.active', { timeout: 10000 });
    await page.waitForFunction(() => window.PARKWISE && window.PARKWISE.appState === 'title');
    if (!(await page.locator('#btn-play').isVisible())) throw new Error('Play button not visible');
    await page.screenshot({ path: SHOT('title', pass) });
  });

  await step('settings open/apply/close', async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#overlay-settings.active');
    await page.check('#opt-high-contrast');
    const hc = await parkwise(() => document.body.classList.contains('high-contrast'));
    if (!hc) throw new Error('high contrast not applied to body');
    await page.uncheck('#opt-high-contrast');
    await page.screenshot({ path: SHOT('settings', pass) });
    await page.click('#btn-settings-close');
    await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
  });

  await step('help open/close', async () => {
    await page.click('#btn-help');
    await page.waitForSelector('#overlay-help.active');
    await page.click('#btn-help-close');
    await page.waitForFunction(() => !document.getElementById('overlay-help').classList.contains('active'));
  });

  await step('mode select shows six modes', async () => {
    await page.click('#btn-play');
    await page.waitForSelector('#screen-modes.active');
    const n = await page.locator('#mode-list .menu-item').count();
    if (n !== 6) throw new Error(`expected 6 modes, got ${n}`);
    await page.screenshot({ path: SHOT('modes', pass) });
  });

  await step('journey setup → stage 1 starts', async () => {
    await page.locator('#mode-list .menu-item', { hasText: 'Journey' }).click();
    await page.waitForSelector('#screen-setup.active');
    await page.locator('#setup-list .menu-item', { hasText: 'Stage 1' }).first().click();
    await page.waitForSelector('#screen-game.active');
    await page.waitForFunction(() => window.PARKWISE.appState === 'active');
    const chip = await page.textContent('#chip-mode');
    if (!/Journey/.test(chip)) throw new Error('mode chip not Journey: ' + chip);
    await page.waitForTimeout(400); // let the board build + camera settle
    await page.screenshot({ path: SHOT('play', pass) });
  });

  await step('pause → resume', async () => {
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause.active');
    await page.waitForFunction(() => window.PARKWISE.appState === 'paused');
    await page.screenshot({ path: SHOT('pause', pass) });
    await page.click('#btn-resume');
    await page.waitForFunction(() => window.PARKWISE.appState === 'active');
  });

  await step('hint + undo via tray buttons', async () => {
    await page.click('#tray-hint');
    const announced = await page.textContent('#sr-announcer');
    if (!/Hint:/.test(announced)) throw new Error('no hint announced: ' + announced);
    // make one solver-guided move, then undo it through the UI
    const mv = await parkwise(() => window.PARKWISE.rules.solve(window.PARKWISE.session.state).firstMove);
    const before = await parkwise(() => window.PARKWISE.session.state.moves);
    await driveMove(page, mv);
    const moves = await parkwise(() => window.PARKWISE.session.state.moves);
    if (moves <= before) throw new Error(`move did not register (${before} -> ${moves})`);
    await page.click('#tray-undo');
    const after = await parkwise(() => window.PARKWISE.session.state.moves);
    if (after !== moves - 1) throw new Error(`undo did not revert one command (${moves} -> ${after})`);
  });

  await step('pointer drag slides a vehicle to an empty cell', async () => {
    const plan = await parkwise(() => {
      const P = window.PARKWISE, s = P.session.state;
      const a = P.rules.legalActions(s).find(x => !P.rules.isWin(P.rules.applyMove(s, x.v, x.dir, x.dist)));
      const v = s.vehicles[a.v];
      const cx = v.ori === 'h' ? v.x + (v.len - 1) / 2 : v.x;
      const cy = v.ori === 'v' ? v.y + (v.len - 1) / 2 : v.y;
      const from = P.screenPosOfCell(cx, cy);
      const to = P.screenPosOfCell(v.ori === 'h' ? cx + a.dir * a.dist : cx, v.ori === 'v' ? cy + a.dir * a.dist : cy);
      return { a, from, to, moves: s.moves };
    });
    await page.mouse.move(plan.from.x, plan.from.y);
    await page.mouse.down();
    await page.mouse.move(plan.to.x, plan.to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(m => window.PARKWISE.session.over || window.PARKWISE.session.state.moves > m, plan.moves, { timeout: 3000 })
      .catch(() => { throw new Error('drag to an empty cell did not commit a move'); });
    await page.click('#tray-undo').catch(() => {});
  });

  await step('solve stage 1 via keyboard', async () => {
    for (let i = 0; i < 60; i++) {
      const mv = await parkwise(() => {
        const P = window.PARKWISE;
        if (P.appState !== 'active' || !P.session || P.session.over) return null;
        const sol = P.rules.solve(P.session.state);
        return sol && sol.firstMove;
      });
      if (!mv) break;
      await driveMove(page, mv);
    }
    await page.waitForSelector('#overlay-results.active', { timeout: 8000 });
    const headline = await page.textContent('#results-h');
    if (!/cleared/i.test(headline)) throw new Error('round not won: ' + headline);
    console.log('  headline:', (await page.textContent('#results-headline')).trim());
    await page.screenshot({ path: SHOT('results', pass) });
  });

  await step('next stage starts (journey progression)', async () => {
    await page.click('#btn-next');
    await page.waitForFunction(() => window.PARKWISE.appState === 'active' && window.PARKWISE.session.entry.id === 'journey-2');
    const unlocked = await parkwise(() => JSON.parse(localStorage.getItem('parkwise.progress.v1')).data.journeyUnlocked);
    if (unlocked < 1) throw new Error('journey progress not persisted: ' + unlocked);
    await page.screenshot({ path: SHOT('stage2', pass) });
  });

  await step('move in stage 2, pause, leave to mode select', async () => {
    // play one legal move through the keyboard, then leave via pause menu
    const mv = await parkwise(() => window.PARKWISE.rules.legalActions(window.PARKWISE.session.state)[0]);
    await driveMove(page, mv);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#overlay-pause.active');
    await page.click('#btn-leave');
    await page.waitForSelector('#screen-modes.active');
  });
}

// Drive one solver move entirely through visible UI: Tab to select the
// vehicle, then arrow keys (one cell per press) along its axis.
async function driveMove(page, mv) {
  const info = await page.evaluate(() => {
    const P = window.PARKWISE;
    return { selected: P.session.selected, count: P.session.state.vehicles.length, vehicles: P.session.state.vehicles.map(v => v.ori) };
  });
  // Tab only cycles vehicles while the board itself holds focus (a real player
  // clicks or tabs into it first); elsewhere it walks the HUD controls.
  await page.locator('#game-canvas').focus();
  const tabs = (mv.v - info.selected + info.count) % info.count;
  for (let t = 0; t < tabs; t++) await page.keyboard.press('Tab');
  const ori = info.vehicles[mv.v];
  const key = ori === 'h' ? (mv.dir > 0 ? 'ArrowRight' : 'ArrowLeft') : (mv.dir > 0 ? 'ArrowDown' : 'ArrowUp');
  for (let d = 0; d < mv.dist; d++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(90);
  }
  const ok = await page.evaluate((want) => {
    const s = window.PARKWISE.session;
    return !s || s.over || s.state.moves > 0; // move committed (or round ended)
  }, mv);
  if (!ok) throw new Error('move did not commit for vehicle ' + mv.v);
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(`server on http://localhost:${server.address().port}`);

let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  const passes = [
    { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', ctx: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ];

  for (const p of passes) {
    const context = await browser.newContext(p.ctx);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`[${p.name}] pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`[${p.name}] console: ${m.text()}`);
    });
    await playthrough(page, p.name);
    await context.close();
    if (errors.length) throw new Error('page errors after ' + p.name + ' pass:\n' + errors.join('\n'));
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nE2E PASS — parkwise playable end-to-end on desktop + mobile, no page errors');
