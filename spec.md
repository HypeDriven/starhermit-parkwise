# Parkwise — Product and Game Specification

**Document status:** design specification only; no implementation is included.  
**Game index:** 16  
**Genre:** Sliding-block puzzle  
**Players:** 1 player; optional asynchronous score comparison  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering direction:** Three.js-first presentation with a fully usable semantic HTML interface layer

## 1. Product vision

Parkwise is a game in which players slide vehicles along their facing axes to open an exit path for the target vehicle. Its signature setting is a compact rooftop parking diorama. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Slide vehicles along their facing axes to open an exit path for the target vehicle.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **inspect the congestion, slide one vehicle along its axis, and create a path to the exit**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Use move count and elapsed time, with unlimited undo and a gradual hint ladder. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC calendar day; hosted play keys the day from the device clock (the dev server can still supply its own time).
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The Three.js canvas fills the game region but is never the only UI. Menus, text, forms, chat, settings, and assistive descriptions use semantic HTML over or beside the canvas. Maintain a single shared layout model so DOM labels align with projected Three.js targets.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.
- **Large screens (above 1600×1000 CSS px):** `ui-scale.js` sets `--ui-scale` (the smaller of width/1600 and height/1000, capped at 2.5); menu screens, overlays, the toast and the game chrome (status bar, rails — whose grid tracks widen by the same factor — and tray) are CSS-`zoom`ed by it with vw/vh lengths divided, while the 3D canvas stays unzoomed and fills the field at native resolution.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Daily challenge, local practice, pause, resume, results, and progression are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; DOM equivalents for canvas controls; headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a compact rooftop parking diorama. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

### Graphics

The diorama uses ACES filmic tone mapping with sRGB output, a hemisphere fill plus one key directional light whose PCF shadow frustum is fitted to the rooftop slab, and distance-relative fog that always starts behind the lot. Optional effects: image-based reflections from a prefiltered studio environment (PMREM of three's RoomEnvironment), GTAO contact darkening, bloom limited to emissive lights (threshold 0.92: exit-gate chevrons, head/tail light bars, lamp posts, antenna beacon), a colour grade with vignette, and FXAA/SMAA/MSAA. **Scene detail** swaps the plain block scene for rounded clear-coated vehicles with glass cabins, axles and light bars (the target car adds a white stripe so it reads by shape, not colour alone), asphalt and concrete grain textures, parapet caps, AC units and vents, lamp posts, a blinking antenna beacon, gate bollards with pulsing chevrons, and an instanced, fogged city skyline whose windows light up at dusk and night. **Particles** adds drifting dust motes and denser win confetti. The selected vehicle lifts slightly with a gentle idle bob; the bob, chevron pulse, beacon blink and dust drift stop under reduced motion. Grid lines stay just under the bloom threshold so they never smear. The title screen has a dusk gradient with a rooftop skyline silhouette.

The Settings panel's **Graphics** section (reachable from the title and the pause menu) offers the theme, a quality preset (Auto, chosen from the WebGL unmasked renderer string: software renderers get Low, discrete GPUs and Apple M-series get High, others Balanced, and touch devices are capped at Balanced; Low; Balanced; High; Ultra), a render scale (50–200% of the preset's), a per-category override for shadows (off/low/medium/high = 1024–4096² maps), ambient occlusion (off/on/high), bloom, colour grade, anti-aliasing (off/FXAA/SMAA/MSAA), reflections, scene detail (plain/detailed) and particles (low/high), each defaulting to "From preset (…)", plus adaptive resolution (averages ~90 frames; steps the scale down 0.1 to 60% above 26 ms and back up 0.05 below 14 ms) and a frame-rate readout in the board's bottom-left corner. A summary line shows GPU · cost · pixel size. Choosing a preset clears overrides; changes apply immediately (shadow maps, post chain, pixel ratio, board rebuild for detail/particles) and persist in `settings.graphics` with the other settings (local cache + cloud save). The pixel ratio is min(device ratio, preset cap: Low 1, Balanced 1.5, High/Ultra 2) × render scale × adaptive scale. Low renders directly without post-processing and matches the original plain scene. If the post-processing module or chain fails, the game renders without it and the panel says so. The panel's strings are localized (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) from the browser language; the old low/medium/high setting migrates to the matching preset.

## 5. Technical architecture

### Client modules

- `bootstrap`: host handshake, capability detection, asset manifest, lifecycle.
- `rules`: pure deterministic state transitions, legality, scoring, seeded random stream.
- `session`: local or hosted commands, snapshots, prediction policy, reconnect, replay.
- `render`: Three.js scene graph, semantic entity views, camera, lighting, VFX, quality.
- `ui`: responsive DOM shell, focus, localization, settings, overlays, accessibility mirror. Overlays open at their top (heading visible): focus moves in with `preventScroll`.
- `audio`: buses, event mapping, focus/background behavior, decode and memory policy.
- `content`: versioned levels, themes, tutorials, validation metadata.
- `gfx` (`gfx.js`): pure quality model — presets, categories, GPU detection, `resolve()`, `describe()`, Graphics panel strings; unit-tested in `tests/gfx.test.js`.
- `post` (`post.js`, lazily imported): EffectComposer chain (Render → GTAO → UnrealBloom → grade → Output → SMAA/FXAA) and the PMREM environment; three.js addons are vendored from the core's revision (r185) under `vendor/three/addons/` and mapped by the page's import map.
- `platform` (`platform.js`): adapter over the shared StarHermit SDK (`starhermit-sdk.js`, `window.StarHermit`) — profile nickname/avatar, `game:<slug>` cloud-save mirror, settings KV, keyboard bindings, sign-in/invite, leaderboard read and score posting (`submitScore`). No WebSocket or telemetry (solo game).

No module may mutate rules state except through a validated command. Rendering consumes immutable snapshots plus interpolation data. UI state and simulation state are separate so closing a drawer cannot affect a match.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Recover WebGL context by rebuilding GPU resources from retained CPU descriptors. If 3D is unavailable, present a clear compatibility message and preserve account/session state.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- The distribution ships `starhermit.txt` at its root (`name`, `description`, `launch=index.html`, `owner`, `server=score-script.js`, `cover`, and one `control.<action>=<codes> | <label>` line per keyboard action) and `starhermit-sdk.js`, an unmodified copy of the canonical StarHermit client loaded before the game modules. `score-script.js` is the platform script (`server=`): it range-checks a round total sent through `StarHermit.submitScores` and posts it to the `high-score` leaderboard (canonical copy in the games repo's `tools/score-script.js`); `server.js` is the local dev server.
- All platform traffic goes through the SDK; `platform.js` adapts it. `StarHermit.init()` reads `#game_token=` (library launch) or `#access_token=` (direct sign-in return) once and strips it; the slug is the `game_scope` claim. Without a token no platform request is made.
- The SDK renews the launch token before expiry. If renewal is refused the profile line returns to the local profile, a "signed out — playing locally" toast shows, sign-in is re-offered and play continues on localStorage.
- The dev server keeps `GET /api/v1/time` for round-trip-adjusted clocks; on `*.starhermit.com` (or when hosted) the UTC day is keyed from the device clock.

### Identity, preferences, and progress
- **Sign-in:** on `*.starhermit.com` without a token the title shows **Sign in with StarHermit** (`StarHermit.signIn()`); hidden when signed in and when running locally.
- **Identity:** the title profile line shows the avatar and profile nickname (fallback `Player ` + id prefix) with the sync state.
- **Cloud save:** the settings+progress doc mirrors to the `game:<slug>` slot (remote preferred on load, 2 s debounce, pagehide flush, visible sync status); the mirror is armed only after that load settles, so nothing is pushed mid-load, and with no remote save the local doc is pushed once. localStorage remains the offline cache.
- **Settings KV:** volumes, mute, theme, graphics, reduced motion, high contrast, large text, captions, hold-to-drag and left-handed layout are patched to the per-player settings store on change and applied at boot (the account value wins).
- **Controls:** keyboard input routes by `KeyboardEvent.code` through `StarHermit.loadBindings()` (platform rebinds over the `control.*` defaults); How to play lists the effective keys. Tab cycling stays a fixed focus control.
- **Invite:** signed in, the title shows **Invite a friend**, which copies `StarHermit.inviteLink()` to the clipboard and confirms with a toast.
- Sign-in/invite labels, toasts and the leaderboard line are localized in all nine locales (`gfx.js` `sh` strings).

### Achievements and leaderboards
- Achievements are a small static local set (unlocks idempotent, cloud-saved); no server declares platform achievements.
- Signed in, every won round in a ranked mode (Journey, Daily, Challenge, Score chase) posts its total through `StarHermit.submitScores` to the `high-score` board (integer, higher is better, 0–20,000); the results screen shows "Leaderboard rank: #N" (or posted / not posted), then the board's top 10 (nickname-resolved). Learn and Practice rounds, lost rounds and standalone play post nothing. Personal bests stay local and cloud-saved. On `*.starhermit.com` the dev-server submit row is hidden. Off-platform the dev server's replay-validated board (`POST/GET /api/v1/scores`) remains.

### Not used
- Sessions, matchmaking, friends picker, chat, replays, realtime rooms and voice, presence, activity and telemetry: the game is solo; `score-script.js` only posts scores and `server.js` is a dev static/API server.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, friends-only filtering, cloud-save conflict handling, activity start/end pairing, and server-time countdown accuracy.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
