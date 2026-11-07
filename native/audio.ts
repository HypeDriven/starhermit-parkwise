// Sound, as the browser build's audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: one or two clips per event, taken in
// turn) on the effects bus, the UI clicks and the pause cue on the interface
// bus (the old "voice cues" bus); the slow lo-fi music loop (sines G B D B A
// C D E, 0.9 s a bar, a lower octave every other bar) and the quiet ambience
// (white noise lowpassed at 320 Hz) while a round plays. The browser build
// ran both live (an interval scheduler and a noise loop); here they are
// rendered once at start (OfflineAudioContext, one a stem) and looped on the
// music bus (the runtime has no ambience bus; the ambience's gain folds in
// the old ambience slider's 40 % default against music's 60 %). The
// oscillator blips the browser build synthesized while a sample decoded are
// not ported (a live synthesis graph makes clip loads fail on the engine's
// web runtime), so a clip still loading is silent. The runtime's Options own
// the volumes, the mute and the voice limit. Every clip loads at start.
import { OfflineAudioContext, SoundBank, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Sfx = "select" | "move" | "invalid" | "undo" | "hint" | "win" | "lose" | "click" | "pause";
const BUS: Record<Sfx, Bus> = { select: "effects", move: "effects", invalid: "effects", undo: "effects", hint: "effects", win: "effects", lose: "effects", click: "interface", pause: "interface" };
const byEvent = new Map<string, string[]>();
const banks = new Map<string, SoundBank>();

/** Reads the manifest and loads every clip at once (onStart); a sound whose clip is still loading is skipped. */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string; event: string }[];
    for (const it of list) {
      if (!it || typeof it.name !== "string" || typeof it.event !== "string") continue;
      byEvent.set(it.event, [...(byEvent.get(it.event) ?? []), it.name]);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  for (const [event, names] of byEvent) {
    const loads = names.map((name) => loadClip(`sfx/${name}.opus`).catch((e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); return null; }));
    void Promise.all(loads).then((loaded) => {
      const list = loaded.filter((c) => c !== null);
      if (list.length) banks.set(event, new SoundBank({ clips: list, order: "sequence", bus: BUS[event as Sfx] }));
    });
  }
  const failed = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
  renderMusic().then((c) => { musicClip = c; }, failed);
  renderAmbience().then((c) => { ambClip = c; }, failed);
}

/** audio.js playSfx(kind): the event's next clip. */
export function play(kind: Sfx): void {
  try { banks.get(kind)?.play(); } catch { /* the mixer is full this frame: skip it */ }
}

// -- the music and the ambience -----------------------------------------------------------------
const RATE = 22050;
const PATTERN = [196, 247, 294, 247, 220, 262, 294, 330]; // G B D B A C D E
const BAR = 0.9;
const MUSIC_N = Math.round(RATE * BAR * PATTERN.length);
/** audio.js tone(): a sine from 0.0001 up to `peak` in 12 ms, then exponentially down to 0.0001 at `dur`. */
const notes: { start: number; f: number; dur: number; peak: number }[] = [];
PATTERN.forEach((f, bar) => {
  notes.push({ start: bar * BAR, f, dur: 0.9, peak: 0.16 });
  if (bar % 2 === 0) notes.push({ start: bar * BAR, f: f / 2, dur: 1.6, peak: 0.12 });
});
const TAIL_N = Math.round(RATE * 0.05);
async function renderMusic(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, MUSIC_N + TAIL_N, RATE);
  for (const n of notes) {
    const osc = off.createOscillator(); osc.frequency.value = n.f;
    const g = off.createGain();
    g.gain.setValueAtTime(0.0001, n.start); g.gain.exponentialRampToValueAtTime(n.peak, n.start + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, n.start + n.dur);
    osc.connect(g).connect(off.destination); osc.start(n.start); osc.stop(n.start + n.dur);
  }
  const data = (await off.startRendering()).getChannelData(0);
  const out = data.slice(0, MUSIC_N);
  for (let i = 0; i < TAIL_N; i++) out[i]! += data[MUSIC_N + i]!; // a tail past the loop's end wraps to its start
  return createClip([out], RATE);
}
/** audio.js startAmbience: 2 s of white noise, a 320 Hz lowpass; filtered periodic noise is periodic once settled, so the loop joins. */
async function renderAmbience(): Promise<AudioClip> {
  const n = RATE * 2, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 11, seconds: 2 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 320;
  noise.connect(lp).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
let musicClip: AudioClip | null = null, ambClip: AudioClip | null = null;
let musicVoice: Sound | null = null, ambVoice: Sound | null = null;
let playing = false;
/** The bed's 0.25 gain at the old ambience slider's 40 % default, on the music bus (60 % default). */
const AMB_GAIN = 0.25 * (0.4 / 0.6);

/** audio.js startMusic/startAmbience (true) and suspendAll (false): the round's music and ambience. */
export function setPlaying(on: boolean): void {
  if (on === playing) return;
  playing = on;
  try {
    if (on) {
      // the scheduler restarted at bar 0 on every start
      musicVoice?.stop(); musicVoice = null;
      ambVoice?.stop(); ambVoice = null;
    } else {
      musicVoice?.fade(0, 0.15);
      ambVoice?.fade(0, 0.15);
    }
  } catch { /* gone */ }
}

/** Each frame, once the mixer runs: the rendered loops start. */
export function update(): void {
  if (context.state !== "running" || !playing) return;
  try {
    if (musicClip && !musicVoice) musicVoice = playClip(musicClip, { bus: "music", loop: true });
    if (ambClip && !ambVoice) ambVoice = playClip(ambClip, { bus: "music", gain: AMB_GAIN, loop: true });
  } catch { /* the mixer is full this frame: next frame */ }
}
