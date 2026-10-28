// The searches off the game's thread (a starhermit:script module worker):
// the hint's breadth-first solve (rules.js solve, as main.js requestHint ran
// it) and a Daily or Practice lot outside levels.js (content.js's generator).
// Natively a search takes up to seconds, longer than a frame may run; on the
// worker the lot keeps drawing meanwhile. rules.js and content.js are the
// browser build's, unchanged.
// In:  { id, kind: "hint", state } | { id, kind: "daily", day } | { id, kind: "practice", tier, attempt }
// Out: { id, move } (null: no hint) | { id, entry } | { id, error }
import "../rules.js";
import "../content.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  const R = globalThis.PARKWISE_RULES, C = globalThis.PARKWISE_CONTENT;
  try {
    if (d.kind === "hint") {
      const sol = R.solve(d.state);
      postMessage({ id: d.id, move: sol && sol.firstMove ? sol.firstMove : null });
    } else if (d.kind === "daily") postMessage({ id: d.id, entry: C.dailyLevel(d.day) });
    else if (d.kind === "practice") postMessage({ id: d.id, entry: C.practiceLevel(d.tier)(d.attempt) });
  } catch (err) {
    postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
