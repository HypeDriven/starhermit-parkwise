// Writes levels.js: content.js's generator results precomputed — the 40
// Journey stages, Practice attempts 0–19 per difficulty and the Dailies of
// 2026-10-01 … 2028-12-31 — so the game never searches for them at run time
// (a generated lot takes up to seconds in V8 and ~20× longer in the engine's
// interpreter). Lots outside the table are still generated (content.js, on a
// worker in the game). The tests check every row against the generator.
//   node tools/gen-levels.mjs [--jobs N] [--verify]   (--verify: regenerate every row and compare with levels.js)
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIRST_DAY = '2026-10-01', LAST_DAY = '2028-12-31', PRACTICE_ATTEMPTS = 20;
export function days() {
  const out = [];
  for (let t = Date.parse(FIRST_DAY + 'T00:00:00Z'); t <= Date.parse(LAST_DAY + 'T00:00:00Z'); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

if (process.argv[2] === '--child') {
  const C = createRequire(join(root, 'package.json'))('./content.js');
  process.on('message', (jobs) => {
    const out = jobs.map(([kind, a, b]) => [kind, a, b, kind === 'journey' ? C.generate.journey(a) : kind === 'daily' ? C.generate.daily(a) : C.generate.practice(a, b)]);
    process.send(out, () => process.exit(0));
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const jobsArg = process.argv.indexOf('--jobs');
  const n = jobsArg > 0 ? +process.argv[jobsArg + 1] : 4;
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(['journey', i, 0]);
  for (let t = 0; t < 3; t++) for (let a = 0; a < PRACTICE_ATTEMPTS; a++) jobs.push(['practice', t, a]);
  for (const d of days()) jobs.push(['daily', d, 0]);
  const buckets = Array.from({ length: n }, () => []);
  jobs.forEach((j, i) => buckets[i % n].push(j));
  // levels.js must not exist while generating (content.js would read it): generate without it.
  const results = await Promise.all(buckets.map((b) => new Promise((res, rej) => {
    const c = fork(fileURLToPath(import.meta.url), ['--child'], { env: { ...process.env, PARKWISE_NO_LEVELS: '1' } });
    c.on('message', res); c.on('error', rej);
    c.send(b);
  })));
  const table = { journey: [], practice: [[], [], []], daily: {} };
  for (const [kind, a, b, row] of results.flat()) {
    if (kind === 'journey') table.journey[a] = row;
    else if (kind === 'practice') table.practice[a][b] = row;
    else table.daily[a] = row;
  }
  if (process.argv.includes('--verify')) {
    const old = createRequire(join(root, 'package.json'))('./levels.js');
    const bad = [];
    table.journey.forEach((r, i) => { if (old.journey[i] !== r) bad.push(`journey ${i}`); });
    table.practice.forEach((rows, t) => rows.forEach((r, a) => { if (old.practice[t][a] !== r) bad.push(`practice ${t}/${a}`); }));
    for (const [d, r] of Object.entries(table.daily)) if (old.daily[d] !== r) bad.push(`daily ${d}`);
    console.log(bad.length ? `MISMATCH: ${bad.join(', ')}` : `levels.js matches the generator (${jobs.length} lots)`);
    process.exit(bad.length ? 1 : 0);
  }
  const dailyRows = Object.keys(table.daily).sort().map((d) => `    ${JSON.stringify(d)}: ${JSON.stringify(table.daily[d])},`).join('\n');
  writeFileSync(join(root, 'levels.js'), `// Parkwise — content.js's generated lots, precomputed by tools/gen-levels.mjs
// (do not edit): rows "par:xyLo …" (vehicle i at column x, row y, length L,
// orientation o; vehicle 0 is the red car). Journey stages 1–40, Practice
// attempts 0–${PRACTICE_ATTEMPTS - 1} per difficulty, Dailies ${FIRST_DAY} … ${LAST_DAY}.
(function (root) {
  var LEVELS = {
  journey: ${JSON.stringify(table.journey, null, 4).replace(/\n/g, '\n  ')},
  practice: ${JSON.stringify(table.practice, null, 4).replace(/\n/g, '\n  ')},
  daily: {
${dailyRows}
  },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LEVELS;
  else root.PARKWISE_LEVELS = LEVELS;
})(globalThis);
`);
  console.log(`levels.js: ${table.journey.length} journey, ${table.practice.map((p) => p.length).join('/')} practice, ${Object.keys(table.daily).length} daily`);
}
