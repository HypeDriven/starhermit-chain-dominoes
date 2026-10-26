// The look of the menus, HUD and overlays: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start. The browser build painted its colours from CSS custom properties
// the table theme set on <html> (content.js THEMES[].css) and the
// colour-vision palette set on <body>, mixed with color-mix(); here those
// colours and mixes are tokens computed per theme and palette and set with
// ui.setTokens, and the hand-drawn dominoes read the same palette. High
// contrast and larger text are the runtime's (it forces the UI's colours and
// scales its text).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Theme } from "./classic.ts";

/** "#rrggbb" or "#rrggbbaa" → [r, g, b, a] 0–255. */
function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}
const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
/** CSS color-mix(in srgb, a k, b): `b` may be "transparent". */
export function mix(a: string, k: number, b: string): string {
  if (b === "transparent") {
    const [r, g, bl, al] = rgba(a);
    return `#${hex2(r)}${hex2(g)}${hex2(bl)}${hex2(al * k)}`;
  }
  const x = rgba(a), y = rgba(b);
  return `#${hex2(x[0] * k + y[0] * (1 - k))}${hex2(x[1] * k + y[1] * (1 - k))}${hex2(x[2] * k + y[2] * (1 - k))}`;
}
export const hexOf = (n: number): string => "#" + n.toString(16).padStart(6, "0");

/** The colour-vision palettes (the browser build's body.cvd-* classes). */
const CVD: Record<string, { good: string; bad: string; accent2: string } | undefined> = {
  protanopia: { good: "#4fa8e0", bad: "#e0b04f", accent2: "#4fa8e0" },
  deuteranopia: { good: "#4fa8e0", bad: "#e0b04f", accent2: "#4fa8e0" },
  tritanopia: { good: "#4fd0c9", bad: "#e06c8a", accent2: "#4fd0c9" },
};

export interface Palette { bg: string; panel: string; panel2: string; text: string; muted: string; accent: string; accent2: string; good: string; bad: string; tileBody: string; tilePip: string; shadow: string }
let palette: Palette = { bg: "#241c15", panel: "#2f261d", panel2: "#3a2f23", text: "#f2ead9", muted: "#b8ac97", accent: "#d98e3a", accent2: "#4f8f74", good: "#6fbf8f", bad: "#e06c5c", tileBody: "#f4efe4", tilePip: "#2b2b30", shadow: "#00000073" };
export function currentPalette(): Palette { return palette; }

function tokensFor(t: Theme, cvd: string): Record<string, string> {
  const c = t.css;
  const v = CVD[cvd];
  const panel2 = mix(c.panel, 0.91, "#ffffff");
  palette = {
    bg: c.bg, panel: c.panel, panel2, text: c.text, muted: "#b8ac97", accent: c.accent,
    accent2: v ? v.accent2 : "#4f8f74", good: v ? v.good : c.good, bad: v ? v.bad : c.bad,
    tileBody: hexOf(t.tileBody), tilePip: hexOf(t.pip), shadow: "#00000073",
  };
  return {
    bg: c.bg, "bg-glow": mix(c.bg, 0.82, c.accent), panel: c.panel, "panel-2": panel2, "panel-2-hover": mix(panel2, 0.8, c.accent),
    "panel-soft": mix(c.panel, 0.9, "transparent"), text: c.text, muted: palette.muted, accent: c.accent,
    "accent-hover": mix(c.accent, 0.85, "#ffffff"), "accent-2": palette.accent2, good: palette.good, bad: palette.bad,
    banner: mix(c.panel, 0.94, c.accent), unlock: mix(c.accent, 0.22, c.panel), "focus-ring": "#ffd27a", "ink-on-accent": "#1a1208",
    line: "#ffffff12", "line-strong": "#ffffff26",
  };
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 25.6, padding: 8, spacing: 8, radius: 12,
    text: "#f2ead9", muted: "#b8ac97", panel: "#2f261d", control: "#3a2f23", hovered: "#5a4128",
    pressed: "#4a3826", field: "#3a2f23", accent: "#d98e3a", focus: "#ffd27a", outline: "#ffffff26",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus-ring", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 44,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "$line-strong" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$text" }, background: "$panel-2", border: { width: 1, color: "$line-strong" }, radius: 8, minHeight: 40 },
    textField: { text: { color: "$text" }, background: "$panel-2", border: { width: 1, color: "$line-strong" }, radius: 8, minHeight: 40, padding: { start: 10, end: 10 } },
    dialog: {
      background: "$panel", radius: 16, padding: 24, border: { width: 1, color: "#ffffff1a" }, shadow: { y: 20, blur: 60, color: "#00000073" },
      parts: { backdrop: { background: "#0a07049e" } },
    },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$text", text: { color: "$bg" }, radius: 6, padding: 6 },
  });
}

let key = "";
/** The table theme's colours and the colour-vision palette, as tokens. */
export function applyTheme(t: Theme, cvd: string): void {
  const k = `${t.id}:${cvd}`;
  if (k === key) return;
  key = k;
  ui.setTokens(tokensFor(t, cvd));
}
