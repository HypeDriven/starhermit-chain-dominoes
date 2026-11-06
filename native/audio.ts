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
// pad and the room tone are offline graphs rendered once into clips; the
// synthesized stand-ins the browser build played while a sample loaded are not
// ported. The clips load and the voices render at once in onStart; the sound
// starts once the mixer runs (in a browser after the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

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
/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of new Set([...FIRST, ...SAMPLE_FILES])) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  void renderVoices().catch((e: unknown) => console.warn(`audio: ${String(e)}`));
}

let captionFn: ((text: string) => void) | null = null;
/** fn(caption key) for each meaningful sound (the browser build's caption strip). */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }
function caption(text: string): void { if (captionFn) captionFn(text); }

/** Plays a sample now or `delay` seconds later by mixer time; whether it is loaded. */
function sample(name: string, delay = 0): boolean {
  const clip = clips.get(name);
  if (!clip) return false;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects, when: delay > 0 ? context.currentTime + delay : 0 }); }
  catch { /* the mixer is full this frame: skip it */ }
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
async function renderChord(freqs: number[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(3.6 * RATE), RATE);
  const env = off.createGain();
  env.gain.setValueAtTime(0, 0);
  env.gain.linearRampToValueAtTime(0.045, 0.8);
  env.gain.linearRampToValueAtTime(0, 3.4);
  env.connect(off.destination);
  for (const f of freqs) {
    const osc = off.createOscillator();
    osc.frequency.value = f;
    osc.connect(env);
    osc.start();
  }
  return createClip(await off.startRendering());
}
/** The café room tone: brown noise lowpassed at 420 Hz, a seamless 4 s loop (filtered periodic noise is periodic once settled). */
const ROOM_GAIN = 0.1564; // measured: rms 0.0305, the old room tone's
async function renderRoom(): Promise<AudioClip> {
  const n = 4 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 4242, seconds: 4 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const g = off.createGain();
  g.gain.value = ROOM_GAIN;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
const chords: AudioClip[] = [];
let room: AudioClip | null = null;
/** Every voice, one graph at a time; the room tone last, as update() waits on it. */
async function renderVoices(): Promise<void> {
  for (const c of CHORDS) chords.push(await renderChord(c));
  room = await renderRoom();
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

/** Each frame once the mixer runs and the voices are rendered: the room tone and the pad's chords by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (!playing || !room) return;
  const now = context.currentTime;
  if (!ambSound) {
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
