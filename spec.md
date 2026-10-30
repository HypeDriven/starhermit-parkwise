# Parkwise — Game Specification

**Genre:** sliding-block parking puzzle · **Players:** 1 (asynchronous leaderboard) · **Platform:** a StarHermit engine script game
(engine 1.30.0, host API 1.32), played natively by the StarHermit client and in browsers by the engine's web runtime.

Parkwise is a rooftop parking diorama: slide cars and vans along the way they face until the red car can drive out through the
glowing exit gate on the right edge of the lot.

## 1. Rules

- The lot is 6 × 6 cells; the exit is on the right edge of row 3. Vehicles are 2 (cars) or 3 (vans) cells long and lie sideways
  (move left/right) or upright (move up/down); they never turn or pass through each other or the lot edge.
- A move slides one vehicle any number of free cells along its axis. The round is won when the red car's front reaches the
  exit (`rules.js isWin`).
- Refused moves ("blocked by another vehicle", "blocked by the lot edge") count as blocked attempts.
- Score (integers, shown as a breakdown): completion base 500, move efficiency 25 × max(0, 3 × par − moves), time bonus
  2 × max(0, 600 − seconds), hint penalty −150 each, blocked-attempt penalty −10 each, challenge bonus +500; never below 0.
  Par is the optimal solution depth (the solver's BFS).
- Undo is unlimited; the hint is the solver's first move from the current position (selects that vehicle and names the
  direction); Restart replays the lot from the start.
- The clock counts only while the round is active (60 fixed steps a second; pause, a hidden window and dialogs stop it).

## 2. Modes and content

- **Learn** — four lessons (Slide a vehicle, Blocked paths, Facing matters, Plan two steps), unranked; finished lessons are kept.
- **Journey** — 40 generated stages of rising density and depth, every tenth a mastery stage; each win unlocks the next and
  earns 1–3 stars (3 at ≥ 90 % of a par run's score, 2 above 700).
- **Daily** — one lot per UTC day (seeded by the date); the day follows the StarHermit server clock when it answered, else the
  device's UTC date.
- **Practice** — Easy / Medium / Hard generated lots; Next deals the next lot of the difficulty, unranked.
- **Challenge** — six constrained lots from the mastery band: a move limit (par + 2), a 45 s speed target ("Time ran out"), or
  no hints.
- **Score chase** — five fixed seeds (Journey stages 6, 13, 20, 27, 34).
- Themes Dawn, Day, Dusk, Night and Contrast (each stage names one; the player may pick one for every lot).

Generating a lot searches with the solver (up to seconds each in V8, ~20× longer in the engine's interpreter), so `levels.js`
holds `content.js`'s results precomputed by `tools/gen-levels.mjs`: the 40 stages, Practice attempts 0–19 per difficulty and
the Dailies of 2026-10-01 … 2028-12-31. Lots outside the table (later Dailies, later Practice attempts) and every hint are
searched on a script worker (`native/gen-worker.js`), so the game keeps drawing ("Preparing the lot…").

Achievements (local, cloud-saved): First clear, Mechanic (no undo, hints or blocked attempts, at par or better), Regular (three
wins in a row), Rooftop veteran (a mastery stage), Commuter (50 wins).

## 3. Screens and layout

- **Title** — the dusk sky with its rooftop skyline: Play, Daily challenge, Journey (resumes the furthest unlocked stage),
  Settings, How to play, Sign in with StarHermit (signed out) / Invite a friend (signed in), and the profile line (local
  profile, or the player's name with the cloud-sync state).
- **Choose a mode** — the six modes with their description and status (ranked, stage n of 40, Daily done/new); **setup** lists
  the mode's lessons, stages (stars, locks), difficulties, challenges or seeds. Back / Escape steps back.
- **Play** — the status bar (mode, Moves n / par, time, the challenge's limit chip, II Pause); the lot; the tray (Undo, Hint,
  Restart; mirrored with the left-handed tray). Wide windows (≥ 1024 logical px) show the Objective / Progress / Vehicles rail
  on the left (the vehicles as buttons: the screen-reader board model) and the Actions (with their keys) / Session rail on the
  right; compact windows open them as drawers from ☰ and ⚙ over a scrim (a tap outside or Escape closes them). Sound captions
  show above the tray.
- **Pause** (Resume, Settings, Help, Leave round), **results** (headline, score breakdown, career line, the leaderboard section,
  Next after a win, Retry, Exit), **Settings**, **How to play** are dialogs.

## 4. Controls

- **Pointer / touch:** tap a vehicle to select it (its legal-target markers appear), then drag it along its axis (an over-drag
  parks against the nearest obstacle) or tap a marker. With hold-to-drag off, drags do nothing and taps select and move.
- **Keyboard** (rebindable in the runtime's Options): arrows slide the selected vehicle one cell, N picks the next vehicle,
  U undo, H hint, R restart, C reset camera, P pause, Escape pause / close. Tab moves through the buttons; a press on the
  lot gives the keys back to the board.
- **Gamepad:** left stick / D-pad slide, North (Y) next vehicle, East (B) undo, West (X) hint, Start pause, Select restart,
  right stick press reset camera. The runtime's UI navigation reaches every button.
- Every vehicle and every legal-target marker is a named target on the lot ("red car at column 2, row 3 (target)", "Slide the
  red car to column 5, row 3") for screen readers and play scripts; announcements go through `ui.announce`.

## 5. Settings

- **Runtime Options** (Open Options, Key bindings): sound volumes and mute, the voice limit, graphics level, render scale,
  frame-rate limit and readout, language, text size, high contrast, reduced motion. High contrast swaps the UI to the old
  high-contrast palette; reduced motion snaps slides and stops the bob, pulses, beacon, dust and confetti; text size is the
  runtime's UI scale.
- **Game settings** (engine `settings`, synced with the account): Theme (Per stage or one of the five), Text captions for
  sounds, Hold-to-drag (vs tap-tap), Left-handed tray; Replay tutorial starts lesson 1.

## 6. Look and sound

`native/render.ts` builds the diorama on `starhermit:scene` as the browser build's three.js r185 renderer did: the authored
camera backing off until the lot fits the playfield (framed with `setViewOffset` between the bars and rails), ACES 1.05, the
hemisphere fill and key light (r185 intensities ÷ π), fog behind the lot, the slab, lot, grid lines, parapet with the exit gap,
the pulsing exit gate and seeded props. Graphics levels map the old presets (`native/quality.ts`): Low — Lambert plain blocks,
no shadows or post; Balanced — Standard materials, detailed scene (rounded vehicles with glass cabins, axles and light bars,
the red car's stripe, asphalt / concrete grain, parapet caps, AC units, lamp posts, beacon, gate chevrons, instanced skyline),
1024² shadows, RoomEnvironment reflections (0.45), bloom (0.4 / 0.35 / 0.92), grade, FXAA; High — clear-coated Physical paint
and glass, 2048² shadows, GTAO, SMAA, dust motes; Ultra — 4096², full-resolution GTAO and bloom, MSAA. Dust and confetti scale
with the level within a tier (≤ 2×, ≤ 360).

`native/audio.ts` plays the authored clips (`sfx/manifest.json`: select, move, invalid, undo, hint, win, lose on effects; click
and pause on the interface bus) and, during a round, the lo-fi music loop and the 320 Hz noise bed, rendered once into clips on
the music bus.

## 7. Platform integration

- **Save:** `starhermit:storage` saves hold `{ progress }` (`progress.js`), on the device and in the cloud slot; conflicts and
  remote saves merge record by record (larger unlock / wins / streak / stars / daily and best scores, union of lessons,
  earliest achievement, later last Daily). The browser build's `game:<slug>` doc is foreign: its progress is merged in and its
  theme / captions / hold-to-drag / left-handed choices adopted, then the slot is replaced once. Its settings-KV keys are
  adopted the same way and the ones the runtime replaced (volumes, mute, graphics, motion, contrast, text size) removed.
  Guests' old browser localStorage progress does not migrate.
- **Leaderboard:** signed in, every won ranked round (Journey, Daily, Challenge, Score chase) posts its total through
  `score-script.js` (server-authoritative range check, `high-score`, 0–20,000); the results show the rank line and the
  board's top ten. Signed out the results show the personal best for the lot. Learn and Practice are unranked.
- Sign-in request, invite link (copied to the clipboard), the signed-out notice; no rooms, chat or telemetry.
- `server.js` stays the local dev server (static files, `/api/v1/time`, the replay-validated `/api/v1/scores` board the
  browser build's dev submit row used); the engine client never calls it.

## 8. Checks

- `npm test`: `node --test` for the rules, content, levels table (sampled rows regenerated; `npm run levels:verify` regenerates
  all), progress merge / migration, i18n (every key in the nine locales with matching placeholders; account strings) and the
  dev server; then `tests/native.mjs`: the web index up to date, `tsc`, `starhermit check` with zero warnings and the
  render-check play scripts `tests/native/*.play` (generated by `tools/gen-plays.mjs` from the solver: menus and all lessons;
  Journey 1 with a blocked slide, undo, hint, pause; a portrait phone by touch with the drawer; a landscape phone Practice; the
  speed challenge running out) plus today's Daily solved by keys.
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU at desktop, phone (DPR 3) and
  landscape (DPR 3): a mouse drag, finger taps and a finger drag on the lot, keys, the drawer; fails on console errors.
- `npm run package` writes `index.html` + `starhermit-files.json`; `npm run css` converts `tools/ui-style.css`.

## 9. Known limitations

- Lots outside `levels.js` (Dailies after 2028-12-31, Practice attempts from 20) are generated on the worker and can take tens
  of seconds natively.
- The browser build's dev-server score submission (name field, replay validation) is not part of the engine client.
- Signed-in paths (cloud merge, foreign save, score posting) are covered by unit tests, not live-tested here.
- The old Graphics panel's per-effect overrides are replaced by the runtime's graphics levels.
