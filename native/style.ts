// The look of the menus, HUD and dialogs: the browser build's index.html
// <style>, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (selects,
// scroll bars, focus rings) take, in the old system-ui sans-serif. The old
// body.high-contrast palette is a token set here, applied while the
// runtime's high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
let base: Tokens = {};
/** index.html body.high-contrast. */
const HIGH_CONTRAST: Tokens = { bg: "#000000", panel: "#101418", panel2: "#1d2530", ink: "#ffffff", dim: "#d7dee8", accent: "#ff7b00", focus: "#00e5ff", hover: "#2b3644" };
let current: Tokens = {};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  current = { ...base };
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 12,
    text: "#eef3f8", muted: "#9fb2c8", panel: "#141d2e", control: "#1b2740", hovered: "#253350",
    pressed: "#141d2e", field: "#1b2740", accent: "#e86a3c", focus: "#ffd54f", outline: "#9fb2c8",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$dim", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay: the dialog box over rgba(4, 8, 16, .7).
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#040810b3" } } },
  });
}

let key = "";
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyPalette(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...base, ...(highContrast ? HIGH_CONTRAST : {}) };
  ui.setTokens(current);
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
