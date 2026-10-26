// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the title over its key art, Learn to
// Play, the Journey list, the setup screens (practice form, the daily
// table, challenges, pass-and-play / hosted play), the table (status bar
// with objective, clock and score chips; the Table rail; the Actions rail
// with the turn indicator; the tutorial banner; the chain strip with its
// end caps; the hand tray of semantic domino tiles), Profile, Settings and
// How to Play, and the overlays (pause, round summary, results, the Table
// drawer, the erase confirmation), the toast and the caption strip. The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: both rails docked), compact (601–1023: the Table rail a
// drawer, the Actions rail a narrow column), phone portrait (≤ 600: the
// actions a row above the hand) and short landscape (≤ 500 px tall: as
// compact, with shorter tiles); the left-handed setting mirrors the rails.
// The café table (render.ts) is framed into the playfield the HUD leaves.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { TextureLoader, type Texture } from "starhermit:scene";
import { Content as C, ProgressLib as P, type Stage } from "./classic.ts";
import { tr, N, pn, pt } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, back, commitToEnd, contentGoal, contentName, continueSaved, copyInvite, doAction, eraseProgress, fmtTime, game, hint,
  leaveMatch, matchmake, nav, nextLesson, nextRound, nextStage, onPick, openOverlay, openSetup, closeOverlay, pauseGame,
  progress, quickPlay, replayTutorials, resumeGame, retry, saveName, savedMatch, setBoardTab, settings, signIn,
  skip, startChallenge, startDaily, startJourneyStage, startHotseat, startPractice, startTutorial, today, toggleView, toTitle, undo, view,
} from "./main.ts";
import { currentPalette, mix } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; W: number; H: number; wide: boolean; compact: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  const wide = !shortLand && lw >= 1024;
  const phone = !shortLand && lw <= 600;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, W: f.width / sc, H: f.height / sc, wide, compact: !wide && !phone && !shortLand, phone, shortLand };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 24);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner, { weight: "600" }); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | null, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: "h1" | "h1-small" | "h2" | "h3" | "h3-accent", text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: cls }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** A definition list (CSS grid 1fr / auto, values at the end). */
function dl(label: string, rows: [string, string][], w: number, dtCls = "stat-dt", ddCls = "stat-dd"): void {
  ui.grid(label, () => {
    for (const [k, v] of rows) { para(k, w - 80, dtCls); ui.style(ddCls).label(v); }
  }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: { row: 4, column: 12 }, width: w });
}
function kbdLabel(action: string): string { return bindingLabel(action, "keyboard"); }

// ------------------------------------------------------------------ glyphs (no emoji or symbol fonts)
type Glyph = "star" | "starOutline" | "lock" | "check" | "menu" | "trophy" | "circle" | "dot" | "note";
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return pts;
}
function drawGlyph(kind: Glyph, r: ui.Rect, color: string): void {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2, s = Math.min(r.width, r.height) / 2;
  const w = Math.max(1.5, s * 0.22);
  switch (kind) {
    case "star": draw.polygon(starPts(cx, cy, s), color); break;
    case "starOutline": {
      const p = starPts(cx, cy, s);
      for (let i = 0; i < p.length; i++) { const a = p[i]!, b = p[(i + 1) % p.length]!; draw.line(a[0], a[1], b[0], b[1], color, Math.max(1, s * 0.12)); }
      break;
    }
    case "lock":
      draw.roundRect(cx - s * 0.65, cy - s * 0.1, s * 1.3, s * 0.95, s * 0.15, color);
      draw.strokeRoundRect(cx - s * 0.4, cy - s * 0.85, s * 0.8, s * 1.1, s * 0.4, color, w);
      break;
    case "check": draw.line(cx - s * 0.7, cy, cx - s * 0.2, cy + s * 0.55, color, w); draw.line(cx - s * 0.2, cy + s * 0.55, cx + s * 0.75, cy - s * 0.6, color, w); break;
    case "menu": for (const dy of [-0.55, 0, 0.55]) draw.line(cx - s * 0.75, cy + dy * s, cx + s * 0.75, cy + dy * s, color, w); break;
    case "trophy":
      draw.polygon([[cx - s * 0.7, cy - s * 0.8], [cx + s * 0.7, cy - s * 0.8], [cx + s * 0.45, cy + s * 0.05], [cx - s * 0.45, cy + s * 0.05]], color);
      draw.rect(cx - s * 0.12, cy, s * 0.24, s * 0.5, color);
      draw.rect(cx - s * 0.45, cy + s * 0.5, s * 0.9, s * 0.25, color);
      draw.strokeRoundRect(cx - s * 0.95, cy - s * 0.7, s * 0.5, s * 0.55, s * 0.2, color, w * 0.7);
      draw.strokeRoundRect(cx + s * 0.45, cy - s * 0.7, s * 0.5, s * 0.55, s * 0.2, color, w * 0.7);
      break;
    case "circle": draw.strokeRoundRect(cx - s * 0.7, cy - s * 0.7, s * 1.4, s * 1.4, s * 0.7, color, Math.max(1, s * 0.15)); break;
    case "dot": draw.roundRect(cx - s * 0.35, cy - s * 0.35, s * 0.7, s * 0.7, s * 0.35, color); break;
    case "note":
      draw.roundRect(cx - s * 0.65, cy + s * 0.2, s * 0.55, s * 0.45, s * 0.22, color);
      draw.line(cx - s * 0.12, cy + s * 0.4, cx - s * 0.12, cy - s * 0.7, color, w * 0.8);
      draw.line(cx - s * 0.12, cy - s * 0.7, cx + s * 0.5, cy - s * 0.4, color, w * 0.8);
      break;
  }
}
function glyph(kind: Glyph, size: number, color: string, label = ""): void {
  ui.widget(label, { role: label ? "image" : "none", size: { width: size, height: size }, draw: (r) => drawGlyph(kind, r, color) });
}
function stars(n: number, size: number, color: string, label: string): void {
  ui.row(`stars-${label}`, () => {
    for (let i = 0; i < 3; i++) glyph(i < n ? "star" : "starOutline", size, color, i === 0 ? label : "");
  }, { spacing: size * 0.2, align: "center" });
}

// ------------------------------------------------------------------ dominoes (the browser build's CSS tiles)
const PIP_CELLS: Record<number, number[]> = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
interface TileLook { flat?: boolean; numbers?: boolean; selected?: boolean; unplayable?: boolean; highlight?: boolean; hovered?: boolean; disabled?: boolean }
function drawHalf(x: number, y: number, w: number, h: number, value: number, pip: string, pipFrac: number): void {
  const cw = w / 3, ch = h / 3;
  const d = Math.min(cw, ch) * pipFrac;
  for (const i of PIP_CELLS[value] ?? []) {
    const px = x + (i % 3) * cw + cw / 2, py = y + Math.floor(i / 3) * ch + ch / 2;
    draw.roundRect(px - d / 2, py - d / 2, d, d, d / 2, pip);
  }
}
function drawDomino(r: ui.Rect, a: number, b: number, o: TileLook, sc: number): void {
  const pal = currentPalette();
  let { x, y } = r;
  const { width: w, height: h } = r;
  if (!o.flat && !o.disabled) { if (o.selected) y -= 9 * sc; else if (o.hovered) y -= 3 * sc; }
  const rad = 7 * sc;
  const alpha = o.unplayable ? 0.45 : 1;
  const tint = (c: string): string => (alpha < 1 ? mix(c, alpha, pal.bg) : c);
  // shadow, body, the lower lip
  draw.roundRect(x, y + 3 * sc, w, h, rad, "#00000040");
  if (o.selected) draw.roundRect(x - 3 * sc, y - 3 * sc, w + 6 * sc, h + 6 * sc, rad + 3 * sc, tint(pal.accent));
  if (o.highlight) {
    const k = 3 + (Math.sin(frame().time * 5.2) * 0.5 + 0.5) * 2;
    draw.roundRect(x - k * sc, y - k * sc, w + 2 * k * sc, h + 2 * k * sc, rad + k * sc, pal.good);
  }
  draw.roundRect(x, y, w, h, rad, tint(pal.tileBody));
  draw.roundRect(x + 1, y + h - 3 * sc, w - 2, 3 * sc, Math.min(rad, 3 * sc), tint(mix(pal.tileBody, 0.88, "#000000")));
  const pip = tint(pal.tilePip);
  if (o.flat) {
    draw.rect(x + w / 2 - sc, y + h * 0.14, 2 * sc, h * 0.72, tint(mix(pal.tileBody, 0.72, "#000000")));
    drawHalf(x + 2 * sc, y + 2 * sc, w / 2 - 4 * sc, h - 4 * sc, a, pip, 0.62);
    drawHalf(x + w / 2 + 2 * sc, y + 2 * sc, w / 2 - 4 * sc, h - 4 * sc, b, pip, 0.62);
  } else {
    draw.rect(x + w * 0.14, y + h / 2 - sc, w * 0.72, 2 * sc, tint(mix(pal.tileBody, 0.72, "#000000")));
    drawHalf(x + 3 * sc, y + 3 * sc, w - 6 * sc, h / 2 - 6 * sc, a, pip, 0.72);
    drawHalf(x + 3 * sc, y + h / 2 + 3 * sc, w - 6 * sc, h / 2 - 6 * sc, b, pip, 0.72);
  }
  if (o.numbers) {
    draw.text(String(a), x + 3 * sc, y + 1 * sc, { size: 9 * sc, color: pip, weight: "800" });
    draw.text(String(b), x + w - 3 * sc, y + h - 12 * sc, { size: 9 * sc, color: pip, weight: "800", align: "end" });
  }
}

// ------------------------------------------------------------------ art
let keyArt: Texture | null = null;
const resultArt: { win: Texture | null; over: Texture | null } = { win: null, over: null };
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  const loader = new TextureLoader();
  // Decorative: a missing file just leaves the art out.
  loader.loadAsync("assets/key-art.webp").then((t) => { keyArt = t; }, () => undefined);
  loader.loadAsync("assets/results-win.webp").then((t) => { resultArt.win = t; }, () => undefined);
  loader.loadAsync("assets/results-over.webp").then((t) => { resultArt.over = t; }, () => undefined);
}
/** The screens' backdrop: radial-gradient(120% 90% at 50% 0%, bg-glow, bg 60%). */
function backdrop(): void {
  const f = frame();
  const pal = currentPalette();
  draw.rect(0, 0, f.width, f.height, pal.bg);
  draw.box(0, 0, f.width, f.height, { background: { type: "radial", center: { x: 0.5, y: 0 }, radius: { x: 1.2, y: 0.9 }, stops: [{ color: mix(pal.bg, 0.82, pal.accent), at: 0 }, { color: pal.bg, at: 0.6 }] } });
}
/** The title's key art: cover-fit, dimmed (brightness 0.5) and fading into the page toward the bottom. */
function titleArt(): void {
  const f = frame();
  if (!keyArt || ui.preferences().highContrast) return;
  const tw = keyArt.width || 1600, th = keyArt.height || 900;
  const k = Math.max(f.width / tw, f.height / th);
  const sw = f.width / k, sh = f.height / k;
  draw.image(keyArt, 0, 0, f.width, f.height, { source: { x: (tw - sw) / 2, y: (th - sh) * 0.6, width: sw, height: sh }, tint: "#7a7a7a" });
  const bg = currentPalette().bg;
  draw.box(0, 0, f.width, f.height, { background: { type: "linear", angle: 180, stops: [{ color: mix(bg, 0.05, "transparent"), at: 0 }, { color: mix(bg, 0.25, "transparent"), at: 0.55 }, { color: mix(bg, 0.75, "transparent"), at: 1 }] } });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  const playing = app.screen === "game" && !!game;
  if (!playing) { backdrop(); if (app.screen === "title") titleArt(); }
  if (playing) gameScreen(L);
  else {
    switch (app.screen) {
      case "title": titleScreen(L); break;
      case "learn": learnScreen(L); break;
      case "journey": journeyScreen(L); break;
      case "setup": setupScreen(L); break;
      case "profile": profileScreen(L); break;
      case "settings": settingsScreen(L); break;
      case "help": helpScreen(L); break;
      default: break;
    }
  }
  overlays(L);
  toasts(L, playing);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen: its column under a head row, scrolling when taller than the room. */
function screen(key: string, L: Layout, maxW: number, build: (w: number) => void, center = false): void {
  const avail = Math.max(80, L.lh);
  const width = Math.max(200, Math.min(maxW, L.lw - 32));
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => build(width), { width, spacing: 12, align: center ? "center" : "start", padding: { top: 16, bottom: 24 } });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: center ? "center" : "start", padding: { start: center ? 0 : 16 } });
      });
    } else ui.column(`${key}-center`, body, { height: avail, width: L.lw, justify: center ? "center" : "start", align: center ? "center" : "start", padding: { start: center ? 0 : 16 } });
  }, { width: L.lw, height: avail });
}
/** The screen head: ← Back and the heading (plus an extra on its right). */
function head(id: string, title: string, w: number, extra?: () => void): void {
  ui.row(`${id}-head`, () => {
    if (ui.style("btn", "btn-ghost").id(`${id}-first`).button(tr("← Back"))) back();
    heading("h2", title, w - 120, `${id}-h`);
    if (extra) extra();
  }, { spacing: 14, align: "center", width: w });
}

// ------------------------------------------------------------------ title
function logo(): void {
  const pal = currentPalette();
  ui.widget("", {
    role: "none", size: { width: 122, height: 70 }, draw: (r) => {
      const sc = r.width / 122;
      const tile = (cx: number, cy: number, rot: number): void => {
        const w = 34 * sc, h = 62 * sc;
        const c = Math.cos(rot), s = Math.sin(rot);
        const P = (px: number, py: number): [number, number] => [cx + px * c - py * s, cy + px * s + py * c];
        draw.polygon([P(-w / 2, -h / 2 + 4 * sc), P(-w / 2 + 4 * sc, -h / 2), P(w / 2 - 4 * sc, -h / 2), P(w / 2, -h / 2 + 4 * sc), P(w / 2, h / 2 - 4 * sc), P(w / 2 - 4 * sc, h / 2), P(-w / 2 + 4 * sc, h / 2), P(-w / 2, h / 2 - 4 * sc)].map(([px, py]) => [px, py + 6 * sc] as [number, number]), "#00000059");
        draw.polygon([P(-w / 2, -h / 2 + 4 * sc), P(-w / 2 + 4 * sc, -h / 2), P(w / 2 - 4 * sc, -h / 2), P(w / 2, -h / 2 + 4 * sc), P(w / 2, h / 2 - 4 * sc), P(w / 2 - 4 * sc, h / 2), P(-w / 2 + 4 * sc, h / 2), P(-w / 2, h / 2 - 4 * sc)], pal.tileBody);
        const [ax, ay] = P(-w * 0.35, 0), [bx, by] = P(w * 0.35, 0);
        draw.line(ax, ay, bx, by, "#0000004d", 2 * sc);
        const dot = (py: number, col: string): void => { const [px, qy] = P(0, py); draw.roundRect(px - 3.5 * sc, qy - 3.5 * sc, 7 * sc, 7 * sc, 3.5 * sc, col); };
        dot(-h * 0.3, pal.tilePip);
        dot(h * 0.3, pal.accent);
      };
      tile(r.x + 17 * sc, r.y + 36 * sc, 0);
      tile(r.x + 61 * sc, r.y + 31 * sc, 9 * Math.PI / 180);
      tile(r.x + 105 * sc, r.y + 36 * sc, 0);
    },
  });
}
function titleScreen(L: Layout): void {
  const p = progress();
  screen("title", L, 640, (w) => {
    // Short windows: a compact hero and the secondary modes in two columns (no scrolling at 540 px).
    const short = L.lh < 700 && L.lw >= 560;
    const mw = short ? Math.min(560, L.lw * 0.88) : Math.min(340, L.lw * 0.88);
    const bw = short ? (mw - 10) / 2 : mw;
    ui.column("title-hero", () => {
      if (!short) logo();
      heading(L.lw < 520 || short ? "h1-small" : "h1", "Chain Dominoes", w, "title-heading");
      para(tr("A café-table game of matching ends and light hands."), w, "tagline", "tagline", true);
    }, { align: "center", spacing: short ? 2 : 6, padding: { bottom: short ? 4 : 12 } });
    const won = Object.values(p.journey).filter((v) => v.stars > 0).length;
    const dailyDone = !!p.daily[today().dateKey];
    const menuBtn = (id: string, text: string, sub: string | null, act: () => void, badge = false): void => {
      if (ui.style("btn", "btn-menu", { width: bw }).id(id).button(text, {
        content: sub || badge ? () => ui.row(`${id}-face`, () => {
          ui.label(text, { weight: "600" });
          if (sub) ui.style("menu-sub").label(sub);
          if (badge) ui.style("badge").label(tr("done"));
        }, { spacing: 8, align: "center" }) : undefined,
      })) act();
    };
    const modes: (() => void)[] = [
      () => menuBtn("btn-daily", tr("Daily Table"), null, () => openSetup("daily"), dailyDone),
      () => menuBtn("btn-journey", tr("Journey"), `${won}/40`, () => nav("journey")),
      () => menuBtn("btn-practice", tr("Practice"), null, () => openSetup("practice")),
      () => menuBtn("btn-challenge", tr("Challenges"), null, () => openSetup("challenges")),
      () => menuBtn("btn-learn", tr("Learn to Play"), `${p.tutorials.length}/6`, () => nav("learn")),
      () => menuBtn("btn-hosted", tr(platform.signedIn() ? N("Hosted Play") : N("Pass & Play")), null, () => openSetup("hosted")),
    ];
    ui.column("title-menu", () => {
      const big = ["btn", "btn-primary", short ? "btn-action" : "btn-big"];
      if (savedMatch()) button({ id: "btn-continue", text: tr("Continue Match"), style: big, act: continueSaved }, mw);
      button({ id: "btn-play", text: tr("Play"), style: big, act: quickPlay }, mw);
      if (short) for (let i = 0; i < modes.length; i += 2) ui.row(`title-modes-${i}`, () => { modes[i]!(); modes[i + 1]?.(); }, { spacing: 10 });
      else modes.forEach((fn) => fn());
    }, { spacing: short ? 8 : 10, width: mw, align: "center" });
    flow("title-footer", [
      { id: "btn-profile", text: tr("Profile"), style: ["btn", "btn-ghost"], act: () => nav("profile") },
      { id: "btn-settings", text: tr("Settings"), style: ["btn", "btn-ghost"], act: () => nav("settings") },
      { id: "btn-help", text: tr("How to Play"), style: ["btn", "btn-ghost"], act: () => nav("help") },
    ], Math.min(w, 520), "center", 6);
    const plat: Btn[] = [];
    if (platform.inviteLink()) plat.push({ id: "btn-invite", text: pt("invite"), style: ["btn", "btn-ghost"], act: () => void copyInvite() });
    if (!platform.signedIn()) plat.push({ id: "btn-signin", text: pt("signIn"), act: signIn });
    if (plat.length) flow("title-platform", plat, Math.min(w, 520), "center", 6);
    const status = platform.signedIn() ? tr("Connected to StarHermit · cloud saves on") : tr("Offline mode · progress stays on this device");
    para(status, w, "host-status", "host-status", true);
    if (platform.signedIn()) para(pt("signedInAs", { name: platform.displayName() }), w, "host-status", "title-signed-in", true);
    else if (app.signedOut) para(pt("signedOut"), w, "host-status", "title-signed-out", true);
  }, true);
}

// ------------------------------------------------------------------ learn and journey
function learnScreen(L: Layout): void {
  const p = progress();
  screen("learn", L, 720, (w) => {
    head("learn", tr("Learn to Play"), w);
    para(tr("Six short lessons. Each one asks you to make the move yourself."), w, "screen-sub");
    C.TUTORIALS.forEach((t, i) => {
      const done = p.tutorials.includes(t.id);
      ui.row(`lesson-${t.id}`, () => {
        const btnW = buttonWidth(tr(done ? N("Replay") : N("Start")), ["btn", "btn-primary"]);
        const tw = w - 36 - btnW - 16 - (done ? 32 : 0);
        ui.column(`lesson-${t.id}-text`, () => {
          para(`${i + 1}. ${tr(t.title)}`, tw, "card-title");
          para(tr(t.intro), tw, "card-desc");
        }, { width: tw, spacing: 2 });
        ui.spacer();
        if (ui.style("btn", "btn-primary").id(`lesson-go-${i}`).button(tr(done ? N("Replay") : N("Start")))) startTutorial(t);
        if (done) glyph("check", 18, currentPalette().good, "✓");
      }, { style: "card", width: w, spacing: 16, align: "center" });
    });
  });
}
function journeyMeta(s: Stage): string {
  return tr("{players}P · {ai} AI · first to {n}", { players: s.players, ai: s.ai.map((d) => tr(d)).join("/"), n: s.targetScore }) +
    (s.drawRule === "none" ? " · " + tr("no draws") : s.drawRule === "one" ? " · " + tr("1 draw/turn") : "") +
    (s.maxRounds ? " · " + tr("≤{n} rounds", { n: s.maxRounds }) : "");
}
function journeyScreen(L: Layout): void {
  const p = progress();
  const pal = currentPalette();
  const total = C.JOURNEY.reduce((n, s) => n + ((p.journey[s.id] || { stars: 0 }).stars || 0), 0);
  screen("journey", L, 720, (w) => {
    head("journey", tr("Journey"), w, () => {
      ui.row("journey-total", () => { glyph("star", 14, pal.accent, tr("Total stars")); ui.style("stars-total").label(`${total} / 120`); }, { spacing: 4, align: "center" });
    });
    para(tr("Forty tables across the café circuit. Mastery tables every eighth stop."), w, "screen-sub");
    let unlocked = true;
    for (const s of C.JOURNEY) {
      const rec = p.journey[s.id];
      const nStars = rec ? rec.stars : 0;
      const open = unlocked;
      const tw = w - 36 - 40 - 72 - 28;
      const label = `${s.number}. ${tr(s.name)}` + (open ? tr(", {n} of 3 stars", { n: nStars }) : tr(", locked"));
      const face = (): void => { ui.row(`stage-${s.number}-face`, () => {
        ui.column(`stage-${s.number}-num`, () => {
          if (s.mastery) glyph("star", 14, pal.accent); else ui.label(String(s.number));
        }, { style: s.mastery ? "journey-num-mastery" : "journey-num", width: 40, height: 40, align: "center", justify: "center" });
        ui.column(`stage-${s.number}-text`, () => {
          para(tr(s.name), tw, "journey-name");
          para(journeyMeta(s), tw, "journey-meta");
        }, { width: tw, spacing: 0 });
        ui.spacer();
        if (open) stars(nStars, 15, pal.accent, ""); else glyph("lock", 18, "#c9a227");
      }, { spacing: 14, align: "center", width: w - 34 }); };
      if (ui.style("journey-item", s.mastery ? "journey-mastery" : null, { width: w }).id(`stage-${s.number}`).button(label, { disabled: !open, content: face }) && open) startJourneyStage(s);
      unlocked = unlocked && nStars > 0;
    }
  });
}

// ------------------------------------------------------------------ setup
function rulesetFacts(rs: { targetScore: number; drawRule?: string; maxRounds?: number }, players: number, ranked: boolean): [string, string][] {
  const drawLabel: Record<string, string> = { "until-playable": N("Draw until playable"), one: N("One draw per turn"), none: N("Boneyard closed") };
  return [
    [tr("Players"), String(players)],
    [tr("Target"), rs.targetScore > 0 ? tr("{n} pts", { n: rs.targetScore }) : tr("Highest score")],
    [tr("Rounds max"), String(rs.maxRounds || 12)],
    [tr("Drawing"), tr(drawLabel[rs.drawRule || "until-playable"]!)],
    [tr("Ranked"), tr(ranked ? N("Yes") : N("No"))],
    [tr("~Duration"), tr("5–15 min")],
  ];
}
function factGrid(label: string, facts: [string, string][], w: number): void {
  const gap = 10;
  const cols = Math.max(1, Math.floor((w + gap) / (140 + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let i = 0; i < facts.length; i += cols) {
      ui.row(`${label}-r${i}`, () => {
        for (const [k, v] of facts.slice(i, i + cols)) {
          ui.column(`${label}-${k}`, () => { para(k.toUpperCase(), cw - 24, "fact-k"); para(v, cw - 24, "fact-v"); }, { style: "fact", width: cw, spacing: 2 });
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function setupScreen(L: Layout): void {
  const kind = app.setup;
  if (!kind) { toTitle(); return; }
  screen("setup", L, 640, (w) => {
    const pw = w - 38;
    if (kind === "practice") {
      head("setup", tr("Practice"), w);
      const f = app.practice;
      ui.column("setup-panel", () => {
        heading("h3", tr("This table"), pw);
        factGrid("setup-facts", rulesetFacts({ targetScore: f.targetScore, drawRule: f.drawRule }, f.players, false), pw);
        const sel = (label: string, id: string, values: (string | number)[], names: string[], cur: string | number, set: (v: string | number) => void): void => {
          ui.row(`${id}-row`, () => {
            para(label, pw * 0.45, "field-label");
            ui.spacer();
            const i = Math.max(0, values.indexOf(cur));
            const next = ui.id(id).select(label, i, names);
            if (next !== i) set(values[next]!);
          }, { width: pw, align: "center", spacing: 10 });
        };
        sel(tr("Players"), "set-players", [2, 3, 4], [2, 3, 4].map((n) => tr("{n} players", { n })), f.players, (v) => { f.players = Number(v); });
        sel(tr("Difficulty"), "set-difficulty", ["easy", "medium", "hard"], [N("easy"), N("medium"), N("hard")].map((d) => tr(d)), f.difficulty, (v) => { f.difficulty = String(v); });
        sel(tr("Target score"), "set-target", [50, 100, 150], [50, 100, 150].map((n) => tr("{n} points", { n })), f.targetScore, (v) => { f.targetScore = Number(v); });
        sel(tr("Draw rule"), "set-draw", ["until-playable", "one", "none"], [N("Draw until playable"), N("One draw per turn"), N("Boneyard closed")].map((d) => tr(d)), f.drawRule, (v) => { f.drawRule = String(v); });
        para(tr("Practice is unranked: undo and hints are on, ratings are untouched."), pw, "muted");
        button({ id: "btn-take-seat", text: tr("Take a seat"), style: ["btn", "btn-primary", "btn-big"], act: startPractice });
      }, { style: "panel", width: w, spacing: 10 });
    } else if (kind === "daily") {
      const d = today();
      const done = !!progress().daily[d.dateKey];
      head("setup", contentName(d), w);
      ui.column("setup-panel", () => {
        heading("h3", tr("This table"), pw);
        factGrid("setup-facts", rulesetFacts(d.ruleset as never, d.players, true), pw);
        para(contentGoal(d), pw, "body", "daily-goal");
        para(tr("One shared seed for everyone today (UTC). Ranked: undo and hints are off.") + (done ? " " + tr("You already played today — replaying is for fun and won't replace your result.") : ""), pw, "muted", "daily-note");
        button({ id: "btn-take-seat", text: tr("Take a seat"), style: ["btn", "btn-primary", "btn-big"], act: startDaily });
      }, { style: "panel", width: w, spacing: 10 });
    } else if (kind === "challenges") {
      head("setup", tr("Challenges"), w);
      C.CHALLENGES.forEach((ch, i) => {
        ui.column(`challenge-panel-${i}`, () => {
          heading("h3", tr(ch.name), pw);
          para(tr(ch.goal), pw, "body");
          const facts = rulesetFacts(ch.ruleset as never, ch.players, true);
          if (ch.timeLimitSec) facts.push([tr("Time limit"), fmtTime(ch.timeLimitSec * 1000)]);
          factGrid(`challenge-facts-${i}`, facts, pw);
          button({ id: `challenge-${i}`, text: tr("Start challenge"), style: ["btn", "btn-primary"], act: () => startChallenge(i) });
        }, { style: "panel", width: w, spacing: 10 });
      });
    } else {
      const hosted = platform.signedIn();
      head("setup", tr(hosted ? N("Hosted Play") : N("Pass & Play")), w);
      ui.column("setup-panel", () => {
        heading("h3", tr("Play with friends"), pw);
        para(hosted
          ? tr("Create a private invitation or join public matchmaking. Hosted sessions are authoritative: the server validates every move.")
          : tr("Hosted play needs the StarHermit shell. Offline, you can still pass-and-play or face the AI."), pw, "body");
        if (hosted) {
          button({ id: "btn-host-invite", text: pt("invite"), act: () => void copyInvite() });
          button({ id: "btn-host-match", text: tr("Find public match"), disabled: app.matchmaking, act: () => void matchmake() });
        }
        button({ id: "btn-hotseat", text: tr("Pass-and-play (2 humans, this device)"), act: startHotseat }, pw);
      }, { style: "panel", width: w, spacing: 10 });
    }
  });
}

// ------------------------------------------------------------------ the table
let statusH = 56;
function objectiveText(): string {
  const g = game!;
  const mode = g.mode, content = g.content, config = g.config!;
  const target = config.ruleset.targetScore;
  if (mode === "tutorial") return tr("Lesson: {text}", { text: tr((content as { title: string }).title) });
  return contentGoal(content) || ((target > 0 ? tr("First to {n}", { n: target }) : tr("First to best score")) + (config.ruleset.drawRule === "none" ? " · " + tr("boneyard closed") : ""));
}
function statusBar(L: Layout, w: number): void {
  const v = view!;
  const pal = currentPalette();
  const left = !!settings.leftHanded;
  const r = ui.place("statusbar", "top-start", () => {
    ui.row("statusbar-row", () => {
      const items: (() => void)[] = [];
      items.push(() => {
        if (ui.style("btn", "btn-ghost", { minWidth: 44, padding: 6 }).id("btn-pause").button(tr("Pause menu"), { content: () => glyph("menu", 18, pal.muted) })) pauseGame();
      });
      items.push(() => {
        ui.column("hud-objective", () => {
          ui.style("hud-objective", { text: { overflow: "ellipsis" } }).id("hud-objective").label(objectiveText());
        }, { grow: 1, height: 44, justify: "center", align: left ? "end" : "start" });
      });
      if (app.clockMs !== null) items.push(() => ui.style("hud-clock").id("hud-clock").label(fmtTime(app.clockMs!)));
      items.push(() => {
        const chips = (): void => {
          for (const [i, p] of v.players.entries()) {
            ui.row(`chip-${i}`, () => {
              ui.label(`${pn(p.name)} ${p.score}`);
              ui.style("chip-pip").label(`(${p.handCount})`);
            }, { style: p.isTurn ? "score-chip-turn" : "score-chip", spacing: 4, align: "center" });
          }
        };
        const chipsW = v.players.reduce((n, p) => n + textWidth(`${pn(p.name)} ${p.score} (${p.handCount})`, "score-chip") + 34, 0) + 10 * (v.players.length - 1);
        const maxW = L.phone ? L.lw * 0.52 : L.lw * 0.6;
        if (chipsW > maxW) ui.scrollArea("hud-scores", { width: maxW, height: 34 }, () => ui.row("hud-scores-row", chips, { spacing: L.phone ? 5 : 10, align: "center" }));
        else ui.row("hud-scores", chips, { spacing: L.phone ? 5 : 10, align: "center" });
      });
      (left ? items.reverse() : items).forEach((fn) => fn());
    }, { width: w - 20, height: 44, spacing: L.phone ? 8 : 12, align: "center" });
  }, { style: "statusbar", width: w });
  statusH = r.height / L.sc;
}
function railLeft(w: number): void {
  const v = view!;
  const g = game!;
  ui.style("rail-title").label(tr("Table").toUpperCase());
  if (v.leftEnd !== null) {
    para(tr("Open ends"), w, "muted");
    ui.row("big-ends", () => {
      ui.style("big-end").id("end-left-value").label(String(v.leftEnd));
      ui.style("big-end").id("end-right-value").label(String(v.rightEnd));
    }, { spacing: 12 });
  } else para(tr("No tiles on the table yet."), w, "muted");
  para(tr("Round {n}", { n: v.round }) + (v.targetScore > 0 ? " · " + tr("target {n}", { n: v.targetScore }) : " · " + tr("single match to best score")), w, "body", "rail-round");
  para(tr(v.boneyardCount === 1 ? N("Boneyard: {n} tile") : N("Boneyard: {n} tiles"), { n: v.boneyardCount }), w, "body", "rail-boneyard");
  const drawLabel: Record<string, string> = { "until-playable": N("Draw until you can play"), one: N("One draw per turn"), none: N("No drawing") };
  const rs = g.config!.ruleset;
  para(tr(drawLabel[rs.drawRule || "until-playable"]!) + " · " + tr("max {n} rounds", { n: rs.maxRounds || 12 }), w, "muted");
}
interface Action { id: string; text: string; key: string; show: boolean; disabled: boolean; selected?: boolean; act: () => void }
function actions(): Action[] {
  const v = view!;
  const g = game!;
  return [
    { id: "btn-draw", text: tr("Draw"), key: kbdLabel("draw"), show: v.canDraw, disabled: !v.myTurn, act: () => doAction({ type: "draw" }) },
    { id: "btn-pass", text: tr("Pass"), key: kbdLabel("pass"), show: v.canPass, disabled: !v.myTurn, act: () => doAction({ type: "pass" }) },
    { id: "btn-hint", text: tr("Hint"), key: kbdLabel("hint"), show: g.options.hints, disabled: !v.myTurn, act: hint },
    { id: "btn-undo", text: tr("Undo"), key: kbdLabel("undo"), show: g.options.undo, disabled: !g.canUndo(), act: undo },
    { id: "btn-skip", text: tr("Skip anim"), key: "", show: true, disabled: false, act: skip },
    { id: "btn-view", text: tr("Top view"), key: "", show: true, disabled: false, selected: render.isTopDown(), act: toggleView },
  ].filter((a) => a.show);
}
function actionButton(a: Action, width: number, showKey: boolean, narrow = false): void {
  const style = narrow ? ["btn", "btn-narrow"] : ["btn", "btn-action"];
  const opts: ui.ButtonOptions = { disabled: a.disabled };
  if (a.selected !== undefined) opts.selected = a.selected;
  if (narrow) opts.content = () => ui.style({ text: { align: "center", size: 12 } }).paragraph(a.text, width - 10, { weight: "600" });
  else if (showKey && a.key) opts.content = () => ui.row(`${a.id}-face`, () => { ui.label(a.text, { weight: "600" }); ui.style("kbd").label(a.key); }, { spacing: 8, align: "center" });
  if (ui.style(...style, { width }).id(a.id).button(a.text, opts)) a.act();
}
function turnText(): string {
  const v = view!;
  return v.phase === "active" ? ((v.myTurn && !v.hotseat) ? tr("Your turn") : tr("{name}’s turn", { name: pn(v.turnName) })) : tr("Round over");
}
function turnIndicator(w: number, compact = false): void {
  const v = view!;
  const t = turnText();
  ui.column("turn-indicator", () => {
    if (compact) ui.style({ text: { align: "center", size: 10 } }).paragraph(t, w - 4, { weight: "600" });
    else para(t, w - 24, null, "turn-text", true);
  }, { style: v.myTurn ? "turn-yours" : "turn-indicator", width: w, align: "center", ...(compact ? { padding: { top: 8, bottom: 8, start: 2, end: 2 } } : {}) });
}

function gameScreen(L: Layout): void {
  const v = view;
  const g = game;
  if (!v || !g) return;
  const pal = currentPalette();
  const left = !!settings.leftHanded;
  statusBar(L, L.lw);
  const top = statusH;
  // hand tray (bottom)
  const tileW = 44, tileH = L.shortLand ? 64 : L.phone ? 74 : 76;
  const trayR = handTray(L, tileW, tileH);
  const trayH = trayR.height / L.sc;
  let railL = 0, railR = 0, actionsH = 0;
  const midH = L.lh - top - trayH;
  if (L.wide) {
    railL = 240; railR = 220;
    ui.place("rail-left", { anchor: left ? "top-end" : "top-start", x: 0, y: top }, () => {
      ui.column("rail-left-col", () => railLeft(railL - 28), { spacing: 10, width: railL - 28 });
    }, { style: left ? "rail-right" : "rail-left", width: railL, height: midH });
    ui.place("rail-right", { anchor: left ? "top-start" : "top-end", x: 0, y: top }, () => {
      ui.style("rail-title").label(tr("Actions").toUpperCase());
      for (const a of actions()) actionButton(a, railR - 28, true);
      ui.spacer();
      turnIndicator(railR - 28);
    }, { style: left ? "rail-left" : "rail-right", width: railR, height: midH, spacing: 10 });
  } else if (L.phone) {
    // the actions a wrapping row above the hand, the turn indicator under them
    const acts = actions();
    const per = Math.min(acts.length, 4);
    const gap = 6;
    const bw = (L.lw - 16 - gap * (per - 1)) / per;
    const r = ui.place("rail-right", { anchor: "bottom-start", x: 0, y: trayH }, () => {
      for (let i = 0; i < acts.length; i += per) {
        ui.row(`acts-r${i}`, () => { for (const a of acts.slice(i, i + per)) actionButton(a, bw, false); }, { spacing: gap });
      }
      turnIndicator(L.lw - 16);
    }, { width: L.lw, spacing: 6, padding: { top: 4, bottom: 4, start: 8, end: 8 }, style: "statusbar" });
    actionsH = r.height / L.sc;
  } else {
    // compact and short landscape: a narrow Actions column; the Table rail is a drawer
    railR = 64;
    ui.place("rail-right", { anchor: left ? "top-start" : "top-end", x: 0, y: top }, () => {
      for (const a of actions()) actionButton(a, railR - 12, false, true);
      ui.spacer();
      turnIndicator(railR - 12, true);
    }, { style: left ? "rail-left" : "rail-right", width: railR, height: midH, spacing: 6, padding: 6, align: "center" });
  }
  const playX = left ? railR : railL;
  const playW = L.lw - railL - railR;
  const playH = midH - actionsH;
  // drawer toggle (compact layouts)
  if (!L.wide) {
    ui.place("drawer-toggle", { anchor: "top-start", x: playX + 8, y: top + 6 }, () => {
      if (ui.style("drawer-toggle").id("toggle-rail-left").button(tr("Toggle table panel"), {
        content: () => ui.row("drawer-face", () => { glyph("menu", 14, pal.text); ui.label(tr("Table")); }, { spacing: 6, align: "center" }),
      })) openOverlay("drawer");
    });
  }
  // tutorial banner (top of the playfield)
  if (v.tutorial) {
    const bw = Math.min(520, playW * 0.92);
    ui.place("tutorial-banner", { anchor: "top-start", x: playX + (playW - bw) / 2, y: top + (L.wide ? 10 : 52) }, () => {
      para(tr("Step {n} of {total}", { n: v.tutorial!.index + 1, total: v.tutorial!.total }).toUpperCase(), bw - 34, "step-count");
      para(tr(v.tutorial!.text), bw - 34, "body", "tutorial-text");
      button({ id: "btn-tutorial-quit", text: tr("Quit lesson"), style: ["btn", "btn-ghost", "btn-sm"], act: leaveMatch });
    }, { style: "tutorial-banner", width: bw, spacing: 4 });
  }
  // chain strip (bottom of the playfield)
  chainStrip(L, playX, top, playW, playH);
  render.setPlayfield((L.ox + playX) * L.sc, (L.oy + top) * L.sc, playW * L.sc, playH * L.sc, frame().width, frame().height);
}

function chainStrip(L: Layout, px: number, top: number, pw: number, ph: number): void {
  const v = view!;
  const g = game!;
  const w = pw - (L.phone ? 12 : 20);
  const sel = v.selectedTile;
  const showEnds = v.myTurn && sel !== null && v.legalEnds.length > 0;
  const capW = 44;
  const ends = (["left", "right"] as const).filter((e) => showEnds && v.legalEnds.includes(e));
  const stripW = w - 16 - ends.length * (capW + 6);
  const endCap = (end: "left" | "right"): void => {
    if (!ends.includes(end)) return;
    const val = end === "left" ? v.leftEnd : v.rightEnd;
    const label = tr(end === "left" ? N("Play selected tile on left end ({value})") : N("Play selected tile on right end ({value})"), { value: val === null ? tr("open table") : val });
    const k = ui.preferences().reducedMotion ? 0 : Math.sin(frame().time * Math.PI / 0.8) * 0.5 + 0.5;
    const pal = currentPalette();
    if (ui.style("end-cap", { border: { color: mix(pal.accent, k, pal.accent2) } }).id(`btn-end-${end}`).button(label, {
      content: () => { if (val === null) glyph("dot", 16, pal.text); else ui.label(String(val)); },
    })) commitToEnd(end);
  };
  ui.place("chain-strip", { anchor: "top-start", x: px + (pw - w) / 2, y: top + ph - 58 - (L.phone ? 4 : 6) }, () => {
    ui.row("chain-strip-row", () => {
      endCap("left");
      const tiles = (): void => {
        if (!v.chain.length) { ui.style("strip-empty").id("strip-empty").label(tr("The table is empty — any tile opens the chain.")); return; }
        for (const c of v.chain) {
          const label = tr(c.double ? N("{tile} double on the table") : N("{tile} on the table"), { tile: `${c.a}|${c.b}` });
          ui.widget(label, { role: "image", size: { width: 58, height: 30 }, draw: (r, st) => drawDomino(r, c.a, c.b, { flat: true, numbers: !!settings.showNumbers }, st.scale) });
        }
      };
      const contentW = v.chain.length * 62;
      if (contentW > stripW) {
        ui.scrollArea("chain-scroll", { width: stripW, height: 34 }, () => ui.row("chain-tiles", tiles, { spacing: 4, align: "center" }), { padding: 0 });
      } else ui.row("chain-tiles", tiles, { spacing: 4, align: "center", justify: "center", width: stripW });
      endCap("right");
    }, { spacing: 6, align: "center", width: w - 16, height: 46, justify: "center" });
  }, { style: "chain-strip", width: w });
  void g;
}

function handTray(L: Layout, tw: number, th: number): ui.Rect {
  const v = view!;
  const g = game!;
  const sel = v.selectedTile;
  const handOwner = v.hotseat ? tr("{name}’s hand", { name: pn(v.myName) }) : tr("Your hand");
  return ui.place("hand-tray", "bottom-start", () => {
    ui.style("hand-label").id("hand-label").label(`${handOwner.toUpperCase()} (${v.myHand.length})`);
    const tiles = (): void => {
      for (const id of v.myHand) {
        const face = v.tileFaces[id];
        if (!face) continue;
        const [a, b] = face;
        const playable = !!v.playableTiles[id];
        const label = tr("{a} | {b} domino", { a, b }) + ", " + tr(playable ? N("playable") : N("not playable now"));
        const hl = (!!v.tutorial?.highlight && v.tutorial.highlight.tileId === id) || app.hintTile?.id === id;
        const res = ui.id(`tile-${id}`).widget(label, {
          role: "button", size: { width: tw, height: th + 10 }, disabled: !v.myTurn,
          draw: (r, st) => drawDomino({ x: r.x, y: r.y + 10 * st.scale, width: r.width, height: r.height - 10 * st.scale }, a, b, {
            numbers: !!settings.showNumbers, selected: sel === id, unplayable: v.myTurn && !playable, highlight: hl, hovered: st.hovered, disabled: !v.myTurn,
          }, st.scale),
        });
        if (res.activated) onPick({ kind: "tile", tileId: id });
      }
    };
    const total = v.myHand.length * (tw + 8);
    if (total > L.lw - 20) ui.scrollArea("hand-scroll", { width: L.lw - 20, height: th + 14 }, () => ui.row("hand-list", tiles, { spacing: 8, align: "end" }), { padding: { top: 2, bottom: 2, start: 4, end: 4 } });
    else ui.row("hand-list", tiles, { spacing: 8, align: "end", height: th + 14 });
  }, { style: "hand-tray", width: L.lw, spacing: 4 });
  void g;
}

// ------------------------------------------------------------------ profile, settings, help
function profileScreen(L: Layout): void {
  const p = progress();
  screen("profile", L, 860, (w) => {
    head("profile", tr("Profile"), w);
    const two = w >= 700;
    const cw = two ? (w - 14) / 2 : w;
    const inner = cw - 38;
    const panel = (id: string, build: () => void): void => { ui.column(id, build, { style: "panel", width: cw, spacing: 10 }); };
    const player = (): void => panel("p-player", () => {
      heading("h3", tr("Player"), inner);
      if (platform.signedIn()) {
        para(tr("Display name"), inner, "field-label");
        para(platform.displayName(), inner, "body", "profile-name");
      } else {
        para(tr("Display name"), inner, "field-label");
        if (nameDraft === null) nameDraft = platform.getDoc().profile.name;
        nameDraft = ui.textField("input-name", nameDraft ?? "", { maxChars: 24, width: inner });
        if (ui.submitted("input-name")) saveName(nameDraft ?? "");
      }
      const sync = platform.syncState();
      const syncTxt = sync === "synced" ? tr("cloud save synced") : sync === "saving" ? tr("saving…") : tr("cloud sync unavailable");
      para(platform.signedIn()
        ? tr("Signed in as {name} — {sync}. The name comes from your platform profile.", { name: platform.displayName(), sync: syncTxt })
        : tr("Guest profile — progress is stored on this device. Launch from the platform for cloud saves."), inner, "muted", "profile-kind");
      if (!platform.signedIn()) button({ id: "btn-save-name", text: tr("Save name"), act: () => saveName(nameDraft ?? "") });
    });
    const record = (): void => panel("p-record", () => {
      heading("h3", tr("Record"), inner);
      const st = p.stats;
      dl("stats-list", [
        [tr("Matches"), String(st.matches)], [tr("Wins"), String(st.wins)], [tr("Win rate"), st.matches ? Math.round(100 * st.wins / st.matches) + "%" : "—"],
        [tr("Current streak"), String(st.streak)], [tr("Best streak"), String(st.bestStreak)], [tr("Rounds played"), String(st.rounds)],
        [tr("Dominos"), String(st.dominos)], [tr("Daily tables"), String(Object.keys(p.daily).length)],
        [tr("Mastery stars"), String(Object.values(p.journey).reduce((s, x) => s + (x.stars || 0), 0))],
      ], inner);
    });
    const achievements = (): void => panel("p-ach", () => {
      heading("h3", tr("Achievements"), inner);
      const pal = currentPalette();
      for (const a of P.ACHIEVEMENTS) {
        const got = !!p.achievements[a.key];
        ui.row(`ach-${a.key}`, () => {
          glyph(got ? "trophy" : "circle", 18, got ? pal.accent : pal.muted);
          para(tr(a.name) + " — " + tr(a.desc), inner - 30, got ? "ach-got" : "ach-row");
        }, { spacing: 10, align: "start" });
      }
    });
    const boards = (): void => panel("p-lb", () => {
      heading("h3", tr("Leaderboards"), inner);
      ui.row("lb-tabs", () => {
        for (const [k, label] of [["local", N("This device")], ["global", N("Global")], ["daily", N("Daily")]] as const) {
          if (ui.style("lb-tab").id(`lb-${k}`).button(tr(label), { selected: app.lbTab === k })) setBoardTab(k);
        }
      }, { spacing: 6 });
      const rows = app.boardRows;
      if (rows && !rows.length) para(tr(app.lbTab === "local" ? N("No scores yet — play a ranked table.") : N("No entries yet.")), inner, "muted", "lb-empty");
      if (rows) rows.forEach((e, i) => para(`${i + 1}. ${e.name} — ${e.score}`, inner, "body", `lb-row-${i}`));
      if (app.boardNote) para(tr(app.boardNote), inner, "muted", "lb-note");
    });
    if (two) {
      ui.row("profile-r1", () => { player(); record(); }, { spacing: 14, align: "stretch" });
      ui.row("profile-r2", () => { achievements(); boards(); }, { spacing: 14, align: "stretch" });
    } else { player(); record(); achievements(); boards(); }
  });
}
let nameDraft: string | null = null;

function settingsScreen(L: Layout): void {
  screen("settings", L, 860, (w) => {
    head("settings", tr("Settings"), w);
    const two = w >= 700;
    const cw = two ? (w - 14) / 2 : w;
    const inner = cw - 38;
    const panel = (id: string, title: string, build: () => void): void => {
      ui.column(id, () => { heading("h3", title, inner); build(); }, { style: "panel", width: cw, spacing: 8 });
    };
    const check = (key: "showNumbers" | "leftHanded" | "timingAssist" | "haptics" | "holdToConfirm" | "hints" | "undo", label: string): void => {
      const cur = !!settings[key];
      const next = ui.id(`set-${key}`).checkbox(label, cur);
      if (next !== cur) { platform.setSetting(key, next); }
    };
    const options = (note: string, id: string): void => {
      para(tr(note), inner, "muted");
      button({ id, text: tr("Open Options"), act: () => openMenu() });
    };
    const audioP = (): void => panel("s-audio", tr("Audio"), () => options(N("Music, effects and voice volumes and mute are set in the StarHermit Options (F1)."), "btn-options-audio"));
    const gfxP = (): void => panel("s-graphics", tr("Graphics"), () => {
      ui.row("theme-row", () => {
        para(tr("Table theme"), inner * 0.45, "field-label");
        ui.spacer();
        const ids = C.THEMES.map((t) => t.id);
        const i = Math.max(0, ids.indexOf(settings.theme));
        const next = ui.id("set-theme").select(tr("Table theme"), i, C.THEMES.map((t) => tr(t.name)));
        if (next !== i) platform.setSetting("theme", ids[next]!);
      }, { width: inner, align: "center", spacing: 10 });
      check("showNumbers", tr("Show numbers on tiles"));
      options(N("Graphics quality, render scale and the frame rate are set in the StarHermit Options (F1)."), "btn-options-graphics");
    });
    const a11yP = (): void => panel("s-a11y", tr("Accessibility"), () => {
      check("leftHanded", tr("Left-handed layout"));
      ui.row("cvd-row", () => {
        para(tr("Color-vision palette"), inner * 0.45, "field-label");
        ui.spacer();
        const ids = ["none", "protanopia", "deuteranopia", "tritanopia"];
        const i = Math.max(0, ids.indexOf(settings.colorVision));
        const next = ui.id("set-cvd").select(tr("Color-vision palette"), i, [N("Default"), N("Protanopia"), N("Deuteranopia"), N("Tritanopia")].map((x) => tr(x)));
        if (next !== i) platform.setSetting("colorVision", ids[next]!);
      }, { width: inner, align: "center", spacing: 10 });
      check("timingAssist", tr("Timing assistance (longer limits)"));
      check("haptics", tr("Haptics (vibration)"));
      check("holdToConfirm", tr("Hold to confirm"));
      button({ id: "btn-replay-tutorials", text: tr("Replay tutorials"), act: replayTutorials });
      options(N("Reduced motion, high contrast and text size are set in the StarHermit Options (F1)."), "btn-options-a11y");
    });
    const gameP = (): void => panel("s-game", tr("Gameplay"), () => {
      check("hints", tr("Allow hints"));
      check("undo", tr("Allow undo (practice/journey)"));
    });
    const keysP = (): void => panel("s-keys", tr("Keyboard & gamepad"), () => {
      const names: [string, string][] = [
        ["left", N("Navigate left")], ["right", N("Navigate right")], ["up", N("Navigate up")], ["down", N("Navigate down")],
        ["confirm", N("Confirm")], ["cancel", N("Cancel")], ["pause", N("Pause")], ["undo", N("Undo")], ["hint", N("Hint")],
        ["camera", N("Reset camera")], ["end_left", N("Play on left end")], ["end_right", N("Play on right end")], ["draw", N("Draw")], ["pass", N("Pass")],
      ];
      dl("bindings-list", names.map(([a, n]) => [tr(n), bindings(a).filter((b) => b.device === "keyboard").map((b) => b.label).join(" / ") || "—"]), inner, "stat-dt", "stat-dd");
      para(tr("Gamepad: left stick / D-pad moves focus, A confirms, B cancels, Start pauses, X draws, Y hints."), inner, "muted");
      button({ id: "btn-rebind", text: tr("Change keys and buttons"), act: () => requestRebind() });
    });
    const dataP = (): void => panel("s-data", tr("Data & privacy"), () => {
      para(tr("No usage statistics are collected."), inner, "muted");
      button({ id: "btn-reset-save", text: tr("Erase local progress"), style: ["btn", "btn-danger"], act: () => openOverlay("erase") });
    });
    const panels = [audioP, gfxP, a11yP, gameP, keysP, dataP];
    if (two) {
      for (let i = 0; i < panels.length; i += 2) ui.row(`settings-r${i}`, () => { panels[i]!(); panels[i + 1]?.(); }, { spacing: 14, align: "stretch" });
    } else panels.forEach((fn) => fn());
  });
}

const RULES: [string, string][] = [
  [N("The chain"), N("Tiles connect when touching ends show the same number. Each turn, play one tile on either open end. The open values are shown as large numbers beside the chain.")],
  [N("Your hand"), N("Tap a tile to select it, then tap an end marker to place it. Tiles you can legally play stay bright; others dim. Double-tap a tile with only one legal end to play it instantly.")],
  [N("Doubles"), N("Doubles sit crosswise on the chain. The open value stays the same on that side.")],
  [N("Drawing & passing"), N("No playable tile? Draw from the boneyard. If the boneyard is empty (or the table forbids drawing), pass. When every player passes in a row, the round is blocked.")],
  [N("Scoring"), N("Empty your hand to go \"domino\" and score every pip left in other hands. In a blocked round, the lowest remaining pip total wins the margin. First to the target score takes the match.")],
];
function helpScreen(L: Layout): void {
  screen("help", L, 720, (w) => {
    head("help", tr("How to Play"), w);
    const inner = w - 38;
    for (const [h, t] of RULES) {
      ui.column(`rule-${h}`, () => { heading("h3-accent", tr(h), inner); para(tr(t), inner, "body"); }, { style: "rule-card", width: w, spacing: 6 });
    }
    ui.column("rule-controls", () => {
      heading("h3-accent", tr("Controls"), inner);
      const k = kbdLabel;
      const rows: [string, string][] = [
        [N("Select / confirm"), k("confirm")], [N("Cancel / pause"), `${k("cancel")} / ${k("pause")}`],
        [N("Left end / right end"), `${k("end_left")} / ${k("end_right")}`], [N("Draw / pass"), `${k("draw")} / ${k("pass")}`],
        [N("Undo / hint"), `${k("undo")} / ${k("hint")}`], [N("Reset camera"), k("camera")],
      ];
      for (const [text, keys] of rows) ui.row(`ctl-${text}`, () => { ui.style("kbd-plain").label(keys); para(tr(text), inner - textWidth(keys, "kbd-plain") - 30, "body"); }, { spacing: 8, align: "center" });
      para(tr("Gamepad: D-pad or left stick moves focus, A confirms, B cancels, Start pauses, X draws, Y hints."), inner, "muted");
    }, { style: "rule-card", width: w, spacing: 8 });
  });
}

// ------------------------------------------------------------------ overlays
function dialogFrame(label: string, L: Layout, maxW: number, closable: boolean, build: (w: number) => void): void {
  const w = Math.min(maxW, L.lw - 32) - 48;
  const avail = L.lh - 32 - 48;
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => build(w), { spacing: 10, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body);
    else body();
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && closable && frame().frame !== app.overlayOpenedFrame) {
    if (app.overlay === "pause") resumeGame(); else closeOverlay();
  }
}
function overlays(L: Layout): void {
  switch (app.overlay) {
    case "pause":
      dialogFrame("overlay-pause", L, 420, true, (w) => {
        heading("h2", tr("Paused"), w, "pause-heading");
        button({ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
        button({ id: "btn-pause-settings", text: tr("Settings"), act: () => { closeOverlay(); nav("settings"); } }, w);
        button({ id: "btn-pause-help", text: tr("How to Play"), act: () => { closeOverlay(); nav("help"); } }, w);
        button({ id: "btn-leave-match", text: tr("Leave match"), style: ["btn", "btn-danger"], act: leaveMatch }, w);
      });
      break;
    case "round": roundOverlay(L); break;
    case "results": resultsOverlay(L); break;
    case "drawer":
      if (!game || !view) { closeOverlay(); break; }
      dialogFrame("drawer-left", L, 320, true, (w) => {
        ui.column("drawer-rail", () => railLeft(w), { spacing: 10, width: w });
        button({ id: "btn-drawer-close", text: tr("Close"), act: closeOverlay });
      });
      break;
    case "erase":
      dialogFrame("overlay-erase", L, 420, true, (w) => {
        para(tr("Erase all local progress? This cannot be undone."), w, "body", "erase-text");
        flow("erase-buttons", [
          { id: "btn-erase-yes", text: tr("Erase local progress"), style: ["btn", "btn-danger"], act: eraseProgress },
          { id: "btn-erase-no", text: tr("Cancel"), act: closeOverlay },
        ], w);
      });
      break;
    default: break;
  }
}
function breakdownRow(id: string, left: string, right: string, w: number, cls: string): void {
  ui.row(id, () => {
    para(left, w - 90, cls === "breakdown-head" ? null : "body");
    ui.spacer();
    ui.style(cls === "breakdown-head" ? "breakdown-head" : "pts").label(right);
  }, { style: cls, width: w, spacing: 14, align: "center" });
}
function roundOverlay(L: Layout): void {
  const rr = app.round;
  const g = game;
  if (!rr || !g || !g.state) { closeOverlay(); return; }
  const me = Math.max(0, g._humanIndex());
  dialogFrame("overlay-round", L, 420, false, (w) => {
    heading("h2", tr("Round over"), w, "round-heading");
    ui.column("round-breakdown", () => {
      breakdownRow("rb-head", tr(rr.reason === "domino" ? N("Domino!") : N("Blocked round")).toUpperCase(), tr("points").toUpperCase(), w, "breakdown-head");
      rr.pipTotals.forEach((pips, p) => {
        const name = pn(g.state!.players[p]!.name) + (p === me ? " " + tr("(you)") : "");
        const b = rr.breakdown.find((x) => x.player === p);
        breakdownRow(`rb-${p}`, tr("{name} held {n} pips", { name, n: pips }), b ? "+" + b.points : "0", w, rr.winners.includes(p) ? "breakdown-win" : "breakdown-row");
      });
      breakdownRow("rb-score", tr("Match score").toUpperCase(), g.state!.players.map((pl) => pn(pl.name) + " " + pl.score).join(" · "), w, "breakdown-head");
    }, { spacing: 6, width: w });
    button({ id: "btn-next-round", text: tr("Next round"), style: ["btn", "btn-primary"], act: nextRound });
  });
}
function resultsOverlay(L: Layout): void {
  const g = game;
  const pal = currentPalette();
  dialogFrame("overlay-results", L, 560, false, (w) => {
    const art = (tex: Texture | null): void => {
      if (!tex || L.lh <= 640) return;
      const ah = Math.min(220, w * 9 / 16);
      ui.column("results-art", () => ui.image("", tex, { width: w - 2, height: ah - 2 }), { clip: true, style: "panel", padding: 0 });
    };
    const def = app.lessonDone;
    if (def) {
      const idx = C.TUTORIALS.findIndex((t) => t.id === def.id);
      const next = C.TUTORIALS[idx + 1];
      heading("h2", tr("{title} — complete", { title: tr(def.title) }), w, "results-heading");
      art(resultArt.win);
      para(tr(def.outro), w, "body", "results-outro");
      para(tr("Lessons completed: {n}/6", { n: progress().tutorials.length }), w, "muted", "results-meta");
      flow("results-actions", [
        { id: "btn-results-retry", text: tr(next ? N("Next lesson") : N("Journey")), style: ["btn", "btn-primary"], act: nextLesson },
        { id: "btn-results-menu", text: tr("Menu"), style: ["btn", "btn-ghost"], act: () => { closeOverlay(); toTitle(); } },
      ], w);
      return;
    }
    const res = app.results;
    if (!res || !g) { closeOverlay(); return; }
    const t = res.terminal;
    const title = res.won ? tr(g.mode === "tutorial" ? N("Lesson complete!") : N("You win the table!"))
      : t.tied ? tr("Dead even") : tr("{name} takes the table", { name: pn(res.players[t.winner]!.name) });
    heading("h2", title, w, "results-heading");
    art(res.won ? resultArt.win : resultArt.over);
    if (res.stars) stars(res.stars, 28, pal.accent, tr("{n} of 3 stars", { n: res.stars }));
    ui.column("results-breakdown", () => {
      breakdownRow("res-head", tr("Final score").toUpperCase(), tr("pts").toUpperCase(), w, "breakdown-head");
      t.ranking.forEach((rk) => {
        const pl = res.players[rk.player]!;
        breakdownRow(`res-${rk.player}`, pn(pl.name) + (rk.player === res.me ? " " + tr("(you)") : "") + " — " +
          tr("{plays} plays, {draws} draws, {invalid} invalid", { plays: pl.plays, draws: pl.draws, invalid: pl.invalidActions }), String(pl.score), w, rk.player === t.winner ? "breakdown-win" : "breakdown-row");
      });
    }, { spacing: 6, width: w });
    for (const a of res.unlocked) {
      ui.row(`unlock-${a.key}`, () => { glyph("trophy", 16, pal.accent); para(tr(a.name) + " — " + tr(a.desc), w - 54, "body"); }, { style: "unlock-chip", width: w, spacing: 8, align: "center" });
    }
    if (app.lb) para(app.lb.state === "lbRank" ? pt("lbRank", { rank: app.lb.rank ?? "" }) : pt(app.lb.state), w, "muted", "results-lb");
    const reasons: Record<string, string> = { "target-reached": N("Target score reached"), "rounds-exhausted": N("Round limit reached"), "move-limit": N("Move limit reached"), "time-expired": N("Time expired") };
    para(tr(reasons[t.reason] ?? t.reason) + " · " + tr("{n} rounds", { n: t.rounds }) + " · " + fmtTime(res.elapsedMs) + " · " + tr("seed {seed}", { seed: res.replay.seed }), w, "muted", "results-meta");
    const btns: Btn[] = [{ id: "btn-results-retry", text: tr(g.mode === "tutorial" ? N("Next lesson") : N("Play again")), style: ["btn", "btn-primary"], act: retry }];
    const content = g.content as Stage | null;
    if (g.mode === "journey" && res.won && content && content.number < 40) btns.push({ id: "btn-results-next", text: tr("Next stage"), act: nextStage });
    btns.push({ id: "btn-results-menu", text: tr("Menu"), style: ["btn", "btn-ghost"], act: () => { closeOverlay(); toTitle(); } });
    flow("results-actions", btns, w);
  });
}

// ------------------------------------------------------------------ toast and captions
function toasts(L: Layout, playing: boolean): void {
  const bottom = playing ? (L.phone ? 210 : 140) : 20;
  if (app.caption) {
    const text = tr(app.caption.text);
    ui.place("captions", { anchor: "bottom", y: bottom + (app.toast ? 56 : 0) + 4 }, () => {
      ui.row("caption-row", () => { glyph("note", 12, currentPalette().text); ui.style("captions", { padding: 0, background: "#00000000" }).id("caption-text").label(text); }, { spacing: 4, align: "center" });
    }, { style: "captions" });
  }
  if (!app.toast) return;
  const text = app.toast.text();
  const w = Math.min(L.lw - 32, 560);
  ui.place("toast", { anchor: "bottom", y: bottom }, () => {
    const fits = textWidth(text, "toast") + 50 <= w;
    if (fits) ui.style("toast").id("toast").label(text);
    else ui.style("toast").id("toast").paragraph(text, w - 44);
  }, { width: w, align: "center" });
}

