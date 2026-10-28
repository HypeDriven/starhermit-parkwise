// Requests to the search worker (native/gen-worker.js): a hint for a
// position, or a Daily / Practice lot that levels.js does not hold. Without a
// worker (it failed to start) the search runs on the game's thread, as the
// browser build ran it.
import { worker, type Worker } from "starhermit:script";
import { Content, Rules, type Entry, type Move, type State } from "./classic.ts";

type Reply = { id: number; move?: Move | null; entry?: Entry; error?: string };
let w: Worker | null = null;
let failed = false;
let nextId = 1;
const waiting = new Map<number, (r: Reply | null) => void>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/gen-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as Reply;
      const job = waiting.get(r.id);
      if (!job) return;
      waiting.delete(r.id);
      job(r);
    });
    // A long search reports "not responding" but goes on: the answer still comes.
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`search worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [id, job] of waiting) { waiting.delete(id); job(null); }
    });
  } catch (e) { console.warn(`search worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
/** Starts the worker ahead of the first request (its modules load meanwhile). */
export function warm(): void { ensure(); }

function ask(msg: Record<string, unknown>, sync: () => Reply, done: (r: Reply) => void): () => void {
  const run = (): void => { let r: Reply; try { r = sync(); } catch (e) { r = { id: 0, error: String(e) }; } done(r); };
  const wk = ensure();
  if (!wk) { run(); return () => undefined; }
  const id = nextId++;
  let cancelled = false;
  waiting.set(id, (r) => { if (cancelled) return; if (!r) run(); else done(r); });
  try { wk.post({ id, ...msg }); } catch (e) { waiting.delete(id); console.warn(`search worker: ${String(e)}`); run(); }
  return () => { cancelled = true; waiting.delete(id); };
}

/** The solver's first move from a position (null: none). Returns a cancel. */
export function hint(state: State, done: (move: Move | null) => void): () => void {
  return ask({ kind: "hint", state: JSON.parse(JSON.stringify(state)) as unknown },
    () => { const s = Rules.solve(state); return { id: 0, move: s && s.firstMove ? s.firstMove : null }; },
    (r) => done(r.move ?? null));
}
/** A Daily or Practice lot: at once from levels.js, else from the worker. Returns a cancel. */
export function lot(req: { kind: "daily"; day: string } | { kind: "practice"; tier: number; attempt: number }, done: (entry: Entry | null, error?: string) => void): () => void {
  if (req.kind === "daily" && Content.dailyReady(req.day)) { done(Content.dailyLevel(req.day)); return () => undefined; }
  if (req.kind === "practice" && Content.practiceReady(req.tier, req.attempt)) { done(Content.practiceLevel(req.tier)(req.attempt)); return () => undefined; }
  return ask(req, () => ({ id: 0, entry: req.kind === "daily" ? Content.dailyLevel(req.day) : Content.practiceLevel(req.tier)(req.attempt) }),
    (r) => done(r.entry ?? null, r.error));
}
