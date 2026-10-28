// Sound, as the browser build's audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: one or two clips per event, taken in
// turn) on the effects bus, the UI clicks and the pause cue on the interface
// bus (the old "voice cues" bus); the slow lo-fi music loop (sines G B D B A
// C D E, 0.9 s a bar, a lower octave every other bar) and the quiet ambience
// (white noise lowpassed at 320 Hz) while a round plays. The browser build
// ran both live (an interval scheduler and a noise loop); here they are
// rendered once into clips (createClip, a slice a frame) and looped on the
// music bus (the runtime has no ambience bus; the ambience's gain folds in
// the old ambience slider's 40 % default against music's 60 %). The
// oscillator blips the browser build synthesized while a sample decoded are
// not ported (a live synthesis graph makes clip loads fail on the engine's
// web runtime), so a clip still loading is silent. The runtime's Options own
// the volumes, the mute and the voice limit. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Sfx = "select" | "move" | "invalid" | "undo" | "hint" | "win" | "lose" | "click" | "pause";
const BUS: Record<Sfx, Bus> = { select: "effects", move: "effects", invalid: "effects", undo: "effects", hint: "effects", win: "effects", lose: "effects", click: "interface", pause: "interface" };
const byEvent = new Map<string, string[]>();
const turn = new Map<string, number>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;

/** Reads the manifest; the clips load once the mixer runs (see update). */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string; event: string }[];
    for (const it of list) {
      if (!it || typeof it.name !== "string" || typeof it.event !== "string") continue;
      byEvent.set(it.event, [...(byEvent.get(it.event) ?? []), it.name]);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  wantClips = true;
}

/** audio.js playSfx(kind): the event's next clip. */
export function play(kind: Sfx): void {
  const names = byEvent.get(kind);
  if (!names || !names.length) return;
  const i = ((turn.get(kind) ?? 0) + 1) % names.length;
  turn.set(kind, i);
  const name = names[i]!;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: BUS[kind] }); }
  catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); } // a clip the mixer lost: load it again
}

// -- the music and the ambience -----------------------------------------------------------------
const RATE = 22050;
const PATTERN = [196, 247, 294, 247, 220, 262, 294, 330]; // G B D B A C D E
const BAR = 0.9;
const MUSIC_N = Math.round(RATE * BAR * PATTERN.length);
const music = new Float32Array(MUSIC_N);
/** audio.js tone(): a sine from 0.0001 up to `peak` in 12 ms, then exponentially down to 0.0001 at `dur`. */
const notes: { start: number; f: number; dur: number; peak: number }[] = [];
PATTERN.forEach((f, bar) => {
  notes.push({ start: bar * BAR, f, dur: 0.9, peak: 0.16 });
  if (bar % 2 === 0) notes.push({ start: bar * BAR, f: f / 2, dur: 1.6, peak: 0.12 });
});
let noteAt = 0;
function renderMusic(): boolean {
  const n = notes[noteAt];
  if (!n) return true;
  const s0 = Math.round(n.start * RATE), len = Math.round((n.dur + 0.02) * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t < 0.012 ? 0.0001 * Math.pow(n.peak / 0.0001, t / 0.012) : t < n.dur ? n.peak * Math.pow(0.0001 / n.peak, (t - 0.012) / (n.dur - 0.012)) : 0;
    const k = (s0 + i) % MUSIC_N; // a tail past the loop's end wraps to its start
    music[k] = music[k]! + Math.sin(2 * Math.PI * n.f * t) * env;
  }
  noteAt++;
  return noteAt >= notes.length;
}
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambS = 11, ambY = 0;
/** audio.js startAmbience: 2 s of white noise, a 320 Hz lowpass run twice round so the loop joins. */
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 320) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) {
      ambS = (Math.imul(ambS, 1664525) + 1013904223) >>> 0;
      amb[i] = (ambS / 4294967296) * 2 - 1;
    } else {
      ambY += k * (amb[i]! - ambY);
      amb[i] = ambY;
    }
  }
  return ambPos >= 2 * AMB_N;
}
let musicClip: AudioClip | null = null, ambClip: AudioClip | null = null;
let musicVoice: Sound | null = null, ambVoice: Sound | null = null;
let rendered = false;
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

/** Each frame: the clips once the mixer runs (one at a time), the loops rendered a slice a frame, then started. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const list of byEvent.values()) for (const n of list) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!rendered) {
    if (!musicClip) {
      if (!renderMusic()) return;
      try { musicClip = createClip([music], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); rendered = true; }
      return;
    }
    if (!ambClip) {
      if (!renderAmbience(8000)) return;
      try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
      rendered = true;
      return;
    }
  }
  if (!playing) return;
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true }); } catch { musicVoice = null; }
    return;
  }
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
}
