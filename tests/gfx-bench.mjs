// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and keeps sliding vehicles by dragging them on the 3D lot with the pointer (a
// legal, non-winning move from the rules engine each time, located through the game's own cell → screen
// projection) — vehicles slide, the selection ring and move markers follow, the exit chevrons, beacon
// and dust animate. A finished round goes to Next.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.PARKWISE && window.PARKWISE.appState === 'title', null, { timeout: 30000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings.active');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('active'));
}

const plan = (page, i) => page.evaluate((i) => {
  const P = window.PARKWISE;
  if (P.appState !== 'active' || !P.session || P.session.over) return { results: !!document.querySelector('#overlay-results.active') };
  const s = P.session.state;
  const acts = P.rules.legalActions(s).filter((x) => !P.rules.isWin(P.rules.applyMove(s, x.v, x.dir, x.dist)));
  if (!acts.length) return { none: true };
  const a = acts[i % acts.length], v = s.vehicles[a.v];
  const cx = v.ori === 'h' ? v.x + (v.len - 1) / 2 : v.x;
  const cy = v.ori === 'v' ? v.y + (v.len - 1) / 2 : v.y;
  return {
    from: P.screenPosOfCell(cx, cy),
    to: P.screenPosOfCell(v.ori === 'h' ? cx + a.dir * a.dist : cx, v.ori === 'v' ? cy + a.dir * a.dist : cy),
  };
}, i);

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.active');
  await page.locator('#mode-list .menu-item', { hasText: 'Journey' }).click();
  await page.waitForSelector('#screen-setup.active');
  await page.locator('#setup-list .menu-item', { hasText: 'Stage 1' }).first().click();
  await page.waitForFunction(() => window.PARKWISE.appState === 'active', null, { timeout: 15000 });
  let open = true, i = 0;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        const m = await plan(page, i++);
        if (m.results) await page.click('#btn-next', { timeout: 2000 });
        else if (m.from) {
          await page.mouse.move(m.from.x, m.from.y);
          await page.mouse.down();
          await page.mouse.move(m.to.x, m.to.y, { steps: 8 });
          await page.mouse.up();
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(450).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
