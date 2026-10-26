// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, with the captions the
// browser build mirrored for meaningful sounds; the quiet café room tone (a
// brown-ish noise lowpassed at 420 Hz) and the generative pad (C, Am, F, G:
// three sines a chord, rising over 0.8 s and gone by 3.4 s, a chord every
// 3.4 s) while a match is on.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu cues (hover, modal open and close, tab and
// slider ticks, toasts) → "interface". The old default bus levels (music
// 50 %, effects 80 %, ambience 40 %) are folded into each sound's gain. The
// pad and the room tone, which the browser build made with oscillators and
// a noise buffer, are rendered once into clips (createClip); the synthesized
// stand-ins it played while a sample loaded are not ported (the engine's web
// runtime drops clip loads while a synthesis graph changes: the
// arrow-exodus finding). Clips load once the mixer runs (natively at once,
// in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.5, effects: 0.8, ambience: 0.4 };
const SAMPLE_FILES = [
  "ui-click", "ui-hover", "ui-confirm", "ui-back", "ui-error", "ui-success", "ui-modal-open", "ui-toggle", "tile-place", "tile-draw",
  "pass-knock", "round-win", "round-lose", "match-win", "tab-switch", "panel-close", "toast-notification", "game-pause", "game-resume",
  "timer-warning", "slider-drag", "tile-pickup", "tile-shuffle", "tile-deal", "round-start", "move-undo", "hint-glow", "star-award",
  "new-record", "opponent-turn", "scroll-tick", "tile-flip", "countdown-tick", "combo-low", "combo-mid", "combo-high", "turn-you",
  "table-blocked", "match-lose",
];
const INTERFACE = new Set(["ui-hover", "ui-modal-open", "panel-close", "tab-switch", "slider-drag", "toast-notification", "scroll-tick", "ui-toggle"]);
// The game's first sounds load first.
const FIRST = ["ui-click", "ui-confirm", "tile-pickup", "tile-place", "tile-draw", "pass-knock", "opponent-turn", "turn-you", "tile-shuffle", "tile-deal", "round-start"];

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

let captionFn: ((text: string) => void) | null = null;
/** fn(caption key) for each meaningful sound (the browser build's caption strip). */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }
function caption(text: string): void { if (captionFn) captionFn(text); }

interface Pending { at: number; name: string }
const pending: Pending[] = [];
/** Plays a sample now or `delay` seconds later by mixer time; whether it is loaded. */
function sample(name: string, delay = 0): boolean {
  const clip = clips.get(name);
  if (!clip) return false;
  if (delay > 0) { pending.push({ at: context.currentTime + delay, name }); return true; }
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(name); load(name); } // a clip the mixer lost: load it again
  return true;
}

// -- game events (js/audio.js) ----------------------------------------------------------------
let comboStreak = 0;
let lastPlaceAt = -10;
export const sfx = {
  ack(): void { sample("ui-click"); caption("tap"); },
  select(): void { sample("tile-pickup"); caption("select"); },
  /** Ceramic clack; plays in quick succession escalate a combo cascade. */
  place(): void {
    const t = context.currentTime;
    comboStreak = t - lastPlaceAt < 2.6 ? comboStreak + 1 : 0;
    lastPlaceAt = t;
    const combo = comboStreak >= 6 ? "combo-high" : comboStreak >= 4 ? "combo-mid" : comboStreak >= 2 ? "combo-low" : null;
    const comboPlayed = combo ? sample(combo, 0.06) : false;
    sample("tile-place");
    caption(comboPlayed ? "chain run" : "tile placed");
  },
  draw(): void { comboStreak = 0; sample("tile-draw"); sample("tile-flip", 0.25); caption("draw from boneyard"); },
  pass(): void { comboStreak = 0; sample("pass-knock"); caption("pass"); },
  invalid(): void { sample("ui-error"); caption("not allowed"); },
  hint(): void { sample("hint-glow"); caption("hint"); },
  roundWin(delay = 0): void { sample("round-win", delay); caption("round won"); },
  roundLose(delay = 0): void { sample("round-lose", delay); caption("round lost"); },
  matchWin(): void { sample("match-win"); caption("match won"); },
  matchLose(): void { sample("match-lose"); caption("match lost"); },
  turnYou(): void { sample("turn-you"); caption("your turn"); },
  tableBlocked(): void { sample("table-blocked"); caption("table blocked"); },
  hover(): void { sample("ui-hover"); },
  confirm(): void { if (sample("ui-confirm")) caption("confirmed"); },
  back(): void { sample("ui-back"); },
  success(): void { if (sample("ui-success")) caption("achievement"); },
  modalOpen(): void { sample("ui-modal-open"); },
  panelClose(): void { sample("panel-close"); },
  toggle(): void { sample("ui-toggle"); },
  tabSwitch(): void { sample("tab-switch"); },
  scrollTick(): void { sample("scroll-tick"); },
  sliderDrag(): void { sample("slider-drag"); },
  toast(): void { sample("toast-notification"); },
  gamePause(): void { if (sample("game-pause")) caption("paused"); },
  gameResume(): void { if (sample("game-resume")) caption("resumed"); },
  timerWarning(): void { if (sample("timer-warning")) caption("time running out"); },
  countdownTick(): void { if (sample("countdown-tick")) caption("countdown"); },
  opponentTurn(): void { if (sample("opponent-turn")) caption("opponent’s turn"); },
  star(delay = 0): void { sample("star-award", delay); },
  newRecord(): void { if (sample("new-record")) caption("new record"); },
  undoMove(): void { if (sample("move-undo")) caption("undone"); else sfx.ack(); },
  /** Round begins: boneyard shuffle, the deal, then the start chime. */
  roundIntro(): void { sample("tile-shuffle"); sample("tile-deal", 1.0); if (sample("round-start", 2.0)) caption("round begins"); },
  // js/session.js calls these on its `audio`
  setSeedStream(): void { /* the samples have no seeded variants */ },
  undo(): void { sfx.undoMove(); },
};

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** One pad chord: three sines (a hair detuned), up to 0.045 over 0.8 s, gone by 3.4 s. */
function chordClip(freqs: number[]): AudioClip {
  const n = Math.round(3.6 * RATE);
  const out = new Float32Array(n);
  for (const f of freqs) {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const e = t < 0.8 ? 0.045 * (t / 0.8) : t < 3.4 ? 0.045 * (1 - (t - 0.8) / 2.6) : 0;
      out[i]! += Math.sin(2 * Math.PI * f * t) * e;
    }
  }
  return createClip([out], RATE);
}
/** The café room tone: brown-ish noise lowpassed at 420 Hz, at 0.16, as a 4 s loop whose ends cross-fade. */
function roomToneClip(): AudioClip {
  const n = 4 * RATE, fade = RATE;
  const raw = new Float32Array(n + fade);
  let seed = 4242, last = 0;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 48271) % 2147483647;
    const w = (seed / 2147483647) * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    raw[i] = last * 3.5;
  }
  // RBJ biquad lowpass at 420 Hz, Q 1
  const w0 = (2 * Math.PI * 420) / RATE, alpha = Math.sin(w0) / 2, c = Math.cos(w0), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x0 = raw[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    raw[i] = y0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = raw[i]!;
    if (i < fade) { const k = i / fade; v = v * k + raw[n + i]! * (1 - k); }
    out[i] = Math.max(-1, Math.min(1, v * 0.16));
  }
  return createClip([out], RATE);
}
const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
const chords: AudioClip[] = [];
let room: AudioClip | null = null;
/** One rendered voice a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  if (chords.length < CHORDS.length) { chords.push(chordClip(CHORDS[chords.length]!)); return true; }
  if (!room) { room = roomToneClip(); return true; }
  return false;
}

// -- music and ambience ---------------------------------------------------------------------
let playing = false;
let ducked = false;
let ambSound: Sound | null = null;
let nextChord = 0;
let step = 0;
/** The match's room tone and pad start (js/audio.js startAll). */
export function startAll(): void {
  if (playing) return;
  playing = true;
  step = 0;
  nextChord = 0;
}
export function stopAll(): void {
  playing = false;
  if (ambSound) { const s = ambSound; try { s.fade(0.0001, 0.4); } catch { /* gone */ } setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, 600); }
  ambSound = null;
}
/** Paused: the room tone and the pad rest. */
export function duck(on: boolean): void {
  ducked = on;
  if (ambSound) { try { ambSound.fade(on ? 0.0001 : LEVEL.ambience, 0.3); } catch { ambSound = null; } }
}

/** Each frame: the samples once the mixer runs, one rendered voice a frame,
 * then the delayed one-shots, the room tone and the pad's chords by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of FIRST) load(name);
    for (const name of SAMPLE_FILES) load(name);
  }
  pump();
  const now = context.currentTime;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.at <= now) { const p = pending.splice(i, 1)[0]!; sample(p.name); }
  }
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!playing) return;
  if (!ambSound && room) {
    try { ambSound = playClip(room, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(ducked ? 0.0001 : LEVEL.ambience, 1.5); }
    catch { ambSound = null; }
  }
  if (ducked) { if (nextChord < now) nextChord = now; return; }
  if (now >= nextChord) {
    if (nextChord === 0 || now - nextChord > 1) nextChord = now;
    const clip = chords[step % chords.length];
    if (clip) { try { playClip(clip, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ } }
    step++;
    nextChord += 3.4;
  }
}
