// Chain Dominoes on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, AI, session controller and
// progress are the browser build's js/*.js, unchanged in what they decide;
// this module is what js/ui.js and js/main.js did around them — navigation
// (title → learn / journey / setup / challenges / pass-and-play → the table
// ⇄ pause → round summary → results → next stage or lesson), the selection
// model (a hand tile, then an end; a second tap commits when one end fits),
// the command pipeline with haptics, the hint flash, the speed challenges'
// clock with its ten- and five-second warnings, the resumable match
// (Continue Match), the results with their posting to the high-score
// board, achievements, toasts, captions and announcements, and the
// lifecycle (a hidden window pauses the match; quitting keeps it resumable).
// The screens and HUD are drawn by screens.ts (starhermit:ui), the café
// table by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the AI's thinking delays
// and the match clock count them, so pauses, a hidden window and slow
// frames never cost time and play scripts replay exactly.
import "./classic.ts";
import { frame, onFixedUpdate, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, onPreferencesChange, preferences, setFixedRate, clipboard } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, onPlayerChange, requestSignIn } from "starhermit:platform";
import {
  Content as C, ProgressLib as P, Rules as R, Session,
  type Achievement, type Cmd, type Content, type MatchConfig, type Results, type RoundResult, type SessionInstance, type Stage, type Tutorial, type View,
} from "./classic.ts";
import * as audio from "./audio.ts";
import { sfx } from "./audio.ts";
import { tr, N, pn, pt, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTheme, initStyles } from "./style.ts";

export type ScreenName = "title" | "learn" | "journey" | "setup" | "game" | "profile" | "settings" | "help";
export type OverlayName = "pause" | "round" | "results" | "drawer" | "erase";
export type SetupKind = "practice" | "daily" | "challenges" | "hosted";
export interface Toast { text: () => string; until: number }

const STEP_MS = 1000 / 60;
export const app = {
  screen: "title" as ScreenName,
  /** Where Settings and How to Play go back to (the table, under its pause menu). */
  backTo: "title" as ScreenName,
  overlay: null as OverlayName | null,
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  overlayOpenedFrame: 0,
  focusNext: null as string | null,
  setup: null as SetupKind | null,
  practice: { players: 2, difficulty: "medium", targetScore: 100, drawRule: "until-playable" },
  round: null as RoundResult | null,
  results: null as Results | null,
  lessonDone: null as Tutorial | null,
  lb: null as { state: "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted"; rank?: number | null } | null,
  toast: null as Toast | null,
  caption: null as { text: string; until: number } | null,
  clockMs: null as number | null,
  hintTile: null as { id: number; until: number } | null,
  lbTab: "local" as "local" | "global" | "daily",
  boardRows: null as { name: string; score: string }[] | null,
  boardNote: "",
  matchmaking: false,
  signedOut: false,
};
export let game: SessionInstance | null = null;
export let view: View | null = null;
export const settings = platform.settings;
const now = (): number => frame().time;
let timerWarned = false;
let lastCountdownSec = 0;
let suspended = false;
let actionSeq = 0;

// ------------------------------------------------------------------ helpers
export function progress(): ReturnType<typeof platform.getDoc>["progress"] { return platform.getDoc().progress; }
export function profileName(): string { return platform.displayName(); }
export function today(): ReturnType<typeof C.dailyForDate> { return C.dailyForDate(new Date(platform.nowMs())); }
export function contentName(c: Content | null): string {
  if (!c) return "";
  if ("kind" in c && c.kind === "daily") return C.dailyNameText(c as never, tr);
  return tr(("name" in c && c.name) || ("title" in c && c.title) || "");
}
export function contentGoal(c: Content | null): string {
  if (!c) return "";
  if ("kind" in c && c.kind === "daily") return C.dailyGoalText(c as never, tr);
  const g = ("goal" in c && c.goal) || ("blurb" in c && c.blurb) || "";
  return g ? tr(g) : "";
}
export function announce(text: string, kind: "status" | "error" = "status"): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: kind === "error" ? "assertive" : "polite" });
}
/** A toast (3.2 s); `text` re-reads in the current language. */
export function toast(text: () => string): void {
  app.toast = { text, until: now() + 3.2 };
  sfx.toast();
  announce(text());
}
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ------------------------------------------------------------------ timers on the fixed steps
interface Timer { id: number; left: number; fn: () => void }
const timers: Timer[] = [];
let timerSeq = 0;
const stepTimers = {
  setTimeout(fn: () => void, ms: number): number { const id = ++timerSeq; timers.push({ id, left: Math.max(1, Math.round(ms / STEP_MS)), fn }); return id; },
  clearTimeout(id: number): void { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
};

// ------------------------------------------------------------------ navigation
export function showScreen(name: ScreenName, focus: string | null = null): void {
  if (name !== "game") app.overlay = app.overlay === "erase" ? null : app.overlay;
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name !== "game") ui.setFocus(null);
  render.setActive(name === "game" && !!game);
}
/** Back from a screen: Settings and How to Play to where they were opened from, the rest to the title. */
export function back(): void {
  sfx.back();
  if ((app.screen === "settings" || app.screen === "help") && app.backTo === "game" && game) {
    showScreen("game");
    openOverlay("pause");
    return;
  }
  toTitle();
}
export function nav(name: ScreenName): void {
  app.backTo = app.screen === "game" ? "game" : "title";
  if (name === "profile") refreshBoard();
  showScreen(name, `${name}-first`);
}
export function openOverlay(name: OverlayName): void {
  app.overlay = name;
  app.overlayOpenedFrame = frame().frame;
  if (name !== "pause" && name !== "drawer") sfx.modalOpen();
}
export function closeOverlay(): void {
  const o = app.overlay;
  app.overlay = null;
  if (o && o !== "pause" && o !== "drawer") sfx.panelClose();
}

// ------------------------------------------------------------------ title
export function toTitle(): void {
  if (game) { game.leave(); game = null; }
  view = null;
  app.overlay = null;
  audio.stopAll();
  render.clear();
  showScreen("title", "btn-play");
}
/** The resumable match, if any (Continue Match). */
export function savedMatch(): ReturnType<typeof platform.getDoc>["savedMatch"] { return platform.getDoc().savedMatch; }

export function quickPlay(): void {
  // Shortest path: next unbeaten journey stage (the first lesson before any), else practice.
  const p = progress();
  const next = C.JOURNEY.find((s) => !(p.journey[s.id] || { stars: 0 }).stars);
  if (next && !p.tutorials.length) startTutorial(C.TUTORIALS[0]!);
  else if (next) startJourneyStage(next);
  else openSetup("practice");
}
export function openSetup(kind: SetupKind): void {
  app.setup = kind;
  app.backTo = "title";
  showScreen("setup", kind === "challenges" ? "challenge-0" : kind === "hosted" ? "btn-hotseat" : "btn-take-seat");
}

// ------------------------------------------------------------------ starting a match
export function startTutorial(t: Tutorial): void {
  startMatch("tutorial", t, { seed: t.id, ruleset: t.setup.ruleset, players: t.setup.players.map((p) => ({ ...p })), custom: t.setup });
}
export function startJourneyStage(s: Stage): void { startMatch("journey", s, C.stageToConfig(s, profileName())); }
export function startDaily(): void { const d = today(); startMatch("daily", d, C.dailyToConfig(d, profileName())); }
export function startPractice(): void {
  const f = app.practice;
  const cfg = C.practiceConfig({ players: f.players, difficulty: f.difficulty, targetScore: f.targetScore, drawRule: f.drawRule, seed: "p" + Math.floor(platform.nowMs()) }, profileName());
  startMatch("practice", { id: "practice", name: "Practice" }, cfg);
}
export function startChallenge(i: number): void {
  const ch = C.CHALLENGES[i];
  if (ch) startMatch("challenge", ch, C.challengeToConfig(ch, profileName()));
}
export function startHotseat(): void {
  const cfg: MatchConfig = {
    seed: "hotseat:" + Math.floor(platform.nowMs()), ruleset: { targetScore: 100 },
    players: [{ id: "p1", name: "Player 1", kind: "human" }, { id: "p2", name: "Player 2", kind: "human" }],
  };
  startMatch("practice", { id: "hotseat", name: "Pass and Play" }, cfg);
}

export function startMatch(mode: string, content: Content | null, config: MatchConfig): void {
  app.overlay = null;
  app.round = null;
  app.results = null;
  app.lessonDone = null;
  app.lb = null;
  app.clockMs = null;
  app.hintTile = null;
  if (game) game.leave();
  timers.length = 0;
  const s = new Session({ store: platform.sessionStore, audio: sfx, timers: stepTimers, externalClock: true });
  game = s;
  s.onView = (v) => { view = v; if (v) { render.sync(v, false); render.setSelected(v.selectedTile); } };
  s.onAnnounce = (text, kind) => announce(text, kind === "error" ? "error" : "status");
  s.onEvent = (name, payload) => onSessionEvent(name, payload);
  s.renderer = rendererHooks;
  const options = {
    undo: settings.undo && (mode === "practice" || mode === "journey" || mode === "tutorial"),
    hints: settings.hints && mode !== "daily" && mode !== "challenge",
    ranked: mode === "daily" || mode === "challenge",
    timeLimitSec: content && "timeLimitSec" in content && content.timeLimitSec ? content.timeLimitSec : 0,
  };
  render.clear();
  render.intro();
  s.startMatch(mode, content, config, options);
  if (view) render.sync(view, true);
  if (options.timeLimitSec > 0) app.clockMs = options.timeLimitSec * 1000 * (settings.timingAssist ? 1.5 : 1);
  showScreen("game", null);
  audio.startAll();
  sfx.confirm();
  sfx.roundIntro();
  timerWarned = false;
  lastCountdownSec = 0;
}
/** What js/session.js calls on its `renderer`. */
const rendererHooks = {
  settle(): void { render.settle(); },
  shake(a: number): void { render.shake(a); },
  pause(): void { /* the table keeps drawing behind the pause menu */ },
  resume(): void { /* as above */ },
  syncState(): void { /* onView syncs */ },
  setSelected(): void { /* onView selects */ },
};

// ------------------------------------------------------------------ input → act
function canAct(): boolean { return !!game && app.screen === "game" && !app.overlay && !game.paused; }
export function doAction(cmd: Cmd): void {
  if (!game) return;
  sfx.ack();
  const res = game.act(cmd, "a" + (++actionSeq));
  if (res && res.ok === false && res.reason) haptic(100);
}
export function commitToEnd(end: "left" | "right"): void {
  if (!game || game.selectedTile === null) return;
  doAction({ type: "play", tileId: game.selectedTile, end });
}
/** A hand tile, an end marker or the bare table was picked (pointer, touch or the hand row). */
export function onPick(p: render.Pick): void {
  if (!game || !canAct()) return;
  if (p.kind === "tile") {
    const id = p.tileId;
    const v = game.buildView();
    if (game.selectedTile === id) {
      // second tap on the selected tile: commit if exactly one legal end
      const ends = v && v.legalEnds;
      if (ends && ends.length === 1) doAction({ type: "play", tileId: id, end: ends[0]! });
      else game.selectTile(id);
    } else {
      sfx.ack();
      game.selectTile(id);
      haptic(15);
    }
  } else if (p.kind === "end") commitToEnd(p.end);
  else if (game.selectedTile !== null) { game.selectedTile = null; game._emitView(); }
}
export function draw(): void { if (canAct()) doAction({ type: "draw" }); }
export function pass(): void { if (canAct()) doAction({ type: "pass" }); }
export function hint(): void { if (canAct() && game) game.hint(); }
export function undo(): void { if (canAct() && game) game.undo(); }
export function skip(): void { if (canAct() && game) game.skipToSettled(); }
export function toggleView(): void { render.toggleTopDown(); }
export function selectStep(dir: -1 | 1): void {
  if (!game || !canAct() || !view || !view.myTurn) return;
  const hand = view.myHand;
  if (!hand.length) return;
  const cur = game.selectedTile;
  const idx = cur === null ? -1 : hand.indexOf(cur);
  const next = idx < 0 ? 0 : Math.min(hand.length - 1, Math.max(0, idx + dir));
  sfx.scrollTick();
  if (hand[next] !== cur) game.selectTile(hand[next]!);
  app.focusNext = `tile-${hand[next]}`;
  app.openedFrame = frame().frame - 1;
}

function onSessionEvent(name: string, payload: unknown): void {
  if (name === "round-end") showRoundOverlay(payload as RoundResult);
  else if (name === "results") showResults(payload as Results);
  else if (name === "invalid") haptic(140);
  else if (name === "achievement") { const a = payload as Achievement; sfx.success(); toast(() => tr("Achievement: {name} — {desc}", { name: tr(a.name), desc: tr(a.desc) })); }
  else if (name === "tutorial-complete") showTutorialComplete(payload as Tutorial);
  else if (name === "hint") {
    const m = payload as Cmd;
    if (m.type === "play" && m.tileId !== undefined) app.hintTile = { id: m.tileId, until: now() + 2.2 };
  } else if (name === "clock") {
    const ms = (payload as { remainingMs: number }).remainingMs;
    app.clockMs = ms;
    if (ms <= 10000) {
      if (!timerWarned) { timerWarned = true; sfx.timerWarning(); }
      const sec = Math.ceil(ms / 1000);
      if (ms <= 5000 && sec !== lastCountdownSec) { lastCountdownSec = sec; sfx.countdownTick(); }
    } else { timerWarned = false; lastCountdownSec = 0; }
  }
}

// ------------------------------------------------------------------ pause, leave, continue
export function pauseGame(): void {
  if (!game || app.screen !== "game" || app.overlay) return;
  game.pause();
  sfx.gamePause();
  audio.duck(true);
  openOverlay("pause");
  announce(tr("Paused."));
}
export function resumeGame(): void {
  if (app.overlay === "pause") closeOverlay();
  sfx.gameResume();
  audio.duck(false);
  if (game) game.resume();
  announce(tr("Resumed.") + (game && game.buildView()?.myTurn ? " " + tr("Your turn.") : ""));
}
function snapshot(): void {
  if (!game || !game.state) return;
  const doc = platform.getDoc();
  if (game.state.phase === "active" && game.mode !== "tutorial") {
    doc.savedMatch = { mode: game.mode!, content: game.content, config: game.config!, stateJson: R.serialize(game.state), elapsedMs: game._elapsedMs };
  } else doc.savedMatch = null;
  platform.persist();
}
export function leaveMatch(): void {
  app.overlay = null;
  if (game) { snapshot(); game.leave(); game = null; }
  audio.stopAll();
  audio.duck(false);
  sfx.back();
  toTitle();
}
export function continueSaved(): void {
  const sm = savedMatch();
  if (!sm) return;
  startMatch(sm.mode, sm.content, sm.config);
  const g = game!;
  g.state = R.deserialize(sm.stateJson);
  g._elapsedMs = sm.elapsedMs || 0;
  platform.getDoc().savedMatch = null;
  platform.persist();
  render.clear();
  g._emitView(true);
  if (view) render.sync(view, true);
  g._maybeRunAI();
  const v = g.buildView();
  announce(tr("Match restored.") + " " + (v?.myTurn ? tr("Your turn.") : tr("{name} to play.", { name: pn(g.state!.players[g.state!.turn]!.name) })));
}
export function retry(): void {
  const mode = game ? game.mode : "practice";
  const content = game ? game.content : null;
  const config = game ? game.config : null;
  closeOverlay();
  if (mode === "daily") openSetup("daily");
  else if (mode === "journey" && content) startJourneyStage(content as Stage);
  else if (mode === "challenge" && content) startMatch("challenge", content, C.challengeToConfig(content as never, profileName()));
  else if (mode === "tutorial" && content) startTutorial(content as Tutorial);
  else if (config) startMatch(mode!, content, { ...config, seed: "practice:" + Math.floor(platform.nowMs()) });
}
export function nextStage(): void {
  const c = game?.content as Stage | null;
  if (!c || !c.number) return;
  const next = C.JOURNEY.find((s) => s.number === c.number + 1);
  closeOverlay();
  if (next) startJourneyStage(next); else toTitle();
}
export function nextRound(): void {
  closeOverlay();
  app.round = null;
  if (game) game.continueNextRound();
  sfx.roundIntro();
}
/** The lesson's results "again" button: the next lesson, else the journey. */
export function nextLesson(): void {
  const def = app.lessonDone;
  if (!def) return;
  const idx = C.TUTORIALS.findIndex((t) => t.id === def.id);
  const next = C.TUTORIALS[idx + 1];
  closeOverlay();
  if (next) startTutorial(next);
  else { if (game) { game.leave(); game = null; } audio.stopAll(); render.clear(); nav("journey"); }
}

// ------------------------------------------------------------------ outcomes
function showRoundOverlay(rr: RoundResult): void {
  if (game && game.mode === "tutorial") return; // lessons flow on
  app.round = rr;
  if (game?.state?.phase === "round-over") openOverlay("round");
}
function showResults(res: Results): void {
  app.results = res;
  app.lessonDone = null;
  app.round = null;
  for (let i = 0; i < res.stars; i++) sfx.star(0.4 + i * 0.35);
  postToLeaderboard(res);
  openOverlay("results");
  if (res.unlocked.length) { sfx.success(); toast(() => tr("Achievement unlocked: {name}", { name: tr(res.unlocked[0]!.name) })); }
}
function showTutorialComplete(def: Tutorial): void {
  app.lessonDone = def;
  app.results = null;
  app.lb = null;
  openOverlay("results");
}
/** Signed in: ranked matches (Daily, Challenge, Journey) post the final score; the results show the rank. */
function postToLeaderboard(res: Results): void {
  const mode = game?.mode;
  app.lb = null;
  if (!platform.signedIn() || !(mode === "daily" || mode === "challenge" || mode === "journey") || !res.entry) return;
  const line = { state: "lbPosting" as const };
  app.lb = line;
  void platform.postLeaderboard(res.entry.score).then((r) => {
    if (app.lb !== line) return;
    app.lb = { state: !r.posted ? "lbNotPosted" : r.rank ? "lbRank" : "lbPosted", rank: r.rank };
  });
}

// ------------------------------------------------------------------ profile and data
export function refreshBoard(): void {
  const kind = app.lbTab;
  app.boardRows = null;
  app.boardNote = "";
  if (kind === "local") {
    const board = P.localBoard().slice(0, 20);
    app.boardRows = board.map((e) => ({ name: pn(e.name), score: `${tr("{n} pts", { n: e.score })} (${tr(e.mode)}, ${fmtTime(e.durationMs || 0)})` }));
    app.boardNote = N("Stored on this device only.");
    return;
  }
  void platform.fetchLeaderboard().then((r) => {
    if (app.lbTab !== kind) return;
    app.boardRows = r.entries.map((e) => ({ name: e.name, score: tr("{n} pts", { n: e.score }) }));
    app.boardNote = r.ok ? "" : platform.signedIn() ? N("Platform board unavailable — showing nothing yet.") : N("This game has no platform leaderboard — personal bests live on this device and in your cloud save.");
  });
}
export function setBoardTab(kind: typeof app.lbTab): void {
  if (app.lbTab === kind) return;
  app.lbTab = kind;
  sfx.tabSwitch();
  refreshBoard();
}
export function saveName(name: string): void {
  const v = name.trim().slice(0, 24);
  if (!v) return;
  platform.setGuestName(v);
  announce(tr("Name saved."));
  toast(() => tr("Name saved: {name}", { name: v }));
}
export function replayTutorials(): void {
  progress().tutorials = [];
  platform.persist();
  nav("learn");
}
/** Erase local progress (confirmed): a fresh save. */
export function eraseProgress(): void {
  const doc = platform.getDoc();
  const fresh = P.normalize({});
  doc.progress = fresh.progress;
  doc.savedMatch = null;
  doc.profile = fresh.profile;
  platform.persist();
  closeOverlay();
  toTitle();
}
export async function copyInvite(): Promise<boolean> {
  const link = platform.inviteLink();
  let ok = false;
  if (link) { try { clipboard.writeText(link); ok = true; } catch { ok = false; } }
  toast(() => (ok ? pt("inviteCopied") : pt("inviteFailed")));
  return ok;
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
/** Public matchmaking (the platform's queues): join, poll, leave once matched — the table itself needs realtime play. */
export async function matchmake(): Promise<void> {
  if (app.matchmaking) return;
  try {
    await platform.matchmakingJoin();
    app.matchmaking = true;
    announce(tr("Searching for a match…"));
    const poll = async (): Promise<void> => {
      if (!app.matchmaking) return;
      let st: Awaited<ReturnType<typeof platform.matchmakingPoll>> = null;
      try { st = await platform.matchmakingPoll(); } catch { app.matchmaking = false; return; }
      if (st && st.matched) {
        app.matchmaking = false;
        announce(tr("Match found."));
        toast(() => tr("Match found — hosted tables need the realtime play update; AI and pass-and-play tables are fully playable."));
        try { await platform.matchmakingLeave(); } catch { /* gone */ }
      } else if (st && st.status !== "queued") {
        app.matchmaking = false;
        announce(tr("Matchmaking: {error}", { error: st.status }));
      } else setTimeout(() => void poll(), 3000);
    };
    setTimeout(() => void poll(), 1500);
  } catch (e) {
    app.matchmaking = false;
    announce(tr("Matchmaking unavailable: {error}", { error: e instanceof Error ? e.message : String(e) }), "error");
  }
}

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame && frame().frame !== app.overlayOpenedFrame;
  if (app.overlay) {
    // Escape closes the pause menu and the drawer; the round and results
    // summaries are decision points and need an explicit choice.
    if ((e.action === "cancel" || e.action === "pause") && fresh) {
      if (app.overlay === "pause") resumeGame();
      else if (app.overlay === "drawer" || app.overlay === "erase") closeOverlay();
    }
    return;
  }
  if (app.screen !== "game") {
    if (e.action === "cancel" && fresh && app.screen !== "title") back();
    return;
  }
  if (!game) return;
  switch (e.action) {
    case "pause": pauseGame(); return;
    case "undo": undo(); return;
    case "hint": hint(); return;
    case "camera": render.resetCamera(); return;
    default: break;
  }
  const v = view;
  if (!v || !v.myTurn || !canAct()) {
    if (e.action === "cancel" && fresh) pauseGame();
    return;
  }
  const cur = game.selectedTile;
  switch (e.action) {
    case "left": selectStep(-1); break;
    case "right": selectStep(1); break;
    case "end_left": commitToEnd("left"); break;
    case "end_right": commitToEnd("right"); break;
    case "draw": if (v.canDraw) doAction({ type: "draw" }); break;
    case "pass": if (v.canPass) doAction({ type: "pass" }); break;
    case "confirm":
      // A focused widget (a hand tile, a button) acts by itself; with none,
      // the selected tile goes to its only legal end, else the first tile is picked.
      if (ui.focused()) break;
      if (cur !== null) { if (v.legalEnds.length === 1) commitToEnd(v.legalEnds[0]!); }
      else if (v.myHand.length && e.source !== "keyboard") game.selectTile(v.myHand[0]!);
      break;
    case "cancel":
      if (cur !== null) game.selectTile(cur); // toggles off
      else if (fresh) pauseGame();
      break;
  }
});

// Table taps pick a hand tile or an end; the pointer's hover previews the
// end (the ghost tile). Touch and the mouse can both report one tap: a
// pointer press right after a touch is skipped.
let down: { x: number; y: number } | null = null;
let lastTouch = -1e9;
function sceneDown(x: number, y: number): void { down = canAct() && !ui.pointerOver() ? { x, y } : null; }
function sceneUp(x: number, y: number): void {
  const d = down;
  down = null;
  if (!d || !canAct() || Math.hypot(x - d.x, y - d.y) > 12 * frame().scale) return;
  onPick(render.pick(x, y));
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) sceneDown(e.x, e.y); else sceneUp(e.x, e.y);
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) render.hover(canAct() && !ui.pointerOver() ? render.pick(x, y) : null); });
onTouch((e) => {
  if (!e.primary) return;
  lastTouch = now();
  if (e.phase === "start") sceneDown(e.x, e.y);
  else if (e.phase === "end") sceneUp(e.x, e.y);
  else if (e.phase === "cancel") down = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyThemeNow(): void {
  const t = C.themeById(settings.theme);
  applyTheme(t, settings.colorVision);
  render.setTheme(t);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.onCaption((text) => { app.caption = { text, until: now() + 1.2 }; });
  render.setReducedMotion(preferences().reducedMotion);
  applyThemeNow();
  applyLook();
  toTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => { applyThemeNow(); if (game) game._emitView(); });
onLocaleChange(() => { if (app.screen === "profile") refreshBoard(); });
onSessionEnded(() => { app.signedOut = true; toast(() => pt("signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  // A hidden window pauses the match (the browser build's visibilitychange).
  suspended = true;
  if (game && app.screen === "game" && !game._finished && !app.overlay) pauseGame();
  snapshotKeep();
  platform.flush();
});
onResume(() => { suspended = false; });
onQuit(() => { snapshotKeep(); });
/** The live match kept resumable (Continue Match) without leaving it. */
function snapshotKeep(): void {
  if (!game || !game.state || game.state.phase !== "active" || game.mode === "tutorial") return;
  const doc = platform.getDoc();
  doc.savedMatch = { mode: game.mode!, content: game.content, config: game.config!, stateJson: R.serialize(game.state), elapsedMs: game._elapsedMs };
  platform.persist();
}

onFixedUpdate(() => {
  if (suspended) return;
  // Timers (the AI's turns, a delayed achievement) run while the match is unpaused.
  if (game && !game.paused && timers.length) {
    for (const t of [...timers]) {
      if (--t.left <= 0) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.fn(); }
    }
  }
  if (game && app.screen === "game" && !game.paused && !game._finished && game.state?.phase === "active") game.advanceClock(STEP_MS);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toast && app.toast.until < t0) app.toast = null;
  if (app.caption && t0 > app.caption.until) app.caption = null;
  if (app.hintTile && t0 > app.hintTile.until) app.hintTile = null;
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});

