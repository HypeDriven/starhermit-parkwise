// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop lesson 1's red car
// is dragged by the mouse to the exit (its marker), then Journey stage 1 takes
// a hint by key, pauses and resumes; on the phone lesson 2 is played by finger
// taps on the vehicles and their markers to the results, and the objective
// drawer opens and closes; sideways an easy Practice lot takes a Hint from the
// tray and the red car is dragged by a finger. Widgets and the lot's named
// targets (vehicles, markers) are found through the page's accessibility
// mirror of the engine's UI. Screenshots of each step go to --shots. Fails on
// console errors or warnings, the runtime's error screen, or a view that does
// not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(3000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A drag from one named target to another: the mouse, or a finger (CDP touch). */
  const dragTo = async (from, to) => {
    const a = await find(from).boundingBox(), b = await find(to).boundingBox();
    const x1 = a.x + a.width / 2, y1 = a.y + a.height / 2, x2 = b.x + b.width / 2, y2 = b.y + b.height / 2;
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
    else { await page.mouse.move(x1, y1); await page.mouse.down(); }
    for (let i = 1; i <= 12; i++) {
      const x = x1 + ((x2 - x1) * i) / 12, y = y1 + ((y2 - y1) * i) / 12;
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      else await page.mouse.move(x, y);
      await page.waitForTimeout(40);
    }
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const solved = () => page.getByText('Lot cleared!').first().waitFor({ timeout: 30000 });
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await press('Learn');
      await press('1. Slide a vehicle');
      await find('red car at column 2, row 3 (target)').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await shot('lesson-1');
      await dragTo('red car at column 2, row 3 (target)', 'Slide the red car to column 5, row 3');
      await solved();
      await page.waitForTimeout(800);
      await shot('lesson-1-done');
      await press('Exit');
      await press('Back');
      await press('Journey');
      await find('Hint (H)').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await page.keyboard.press('KeyH');
      await page.waitForTimeout(800);
      await shot('hint');
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(300);
    } else if (v.name === 'phone') {
      await press('Play');
      await press('Learn');
      await press('2. Blocked paths');
      await find('upright car 1 at column 5, row 2').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await shot('lesson-2');
      await press('Open objective panel');
      await page.waitForTimeout(300);
      await shot('drawer');
      await press('Close panel');
      await press('upright car 1 at column 5, row 2');
      await shot('selected');
      await press('Slide the upright car 1 to column 5, row 1');
      await press('red car at column 2, row 3 (target)');
      await press('Slide the red car to column 5, row 3');
      await solved();
      await page.waitForTimeout(800);
      await shot('lesson-2-done');
    } else {
      await press('Play');
      await press('Practice');
      await press('Easy');
      await find('Hint').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await press('Hint');
      await page.waitForTimeout(800);
      await shot('hint');
      const red = page.getByRole('button', { name: /^red car at column/ }).first();
      const name = (await red.getAttribute('aria-label')) || (await red.textContent());
      const m = /column (\d+), row (\d+)/.exec(name);
      const left = `Slide the red car to column ${Number(m[1]) - 1}, row ${m[2]}`;
      await press(name.trim());
      if (await find(left).count()) await dragTo(name.trim(), left);
      await page.waitForTimeout(500);
      await shot('dragged');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
