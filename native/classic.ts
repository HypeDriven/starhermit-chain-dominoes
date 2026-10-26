// The browser build's pure game scripts, shared with the Node tests: rules,
// content, AI, the session controller, progress (achievements, the local
// board, the save document) and the string tables (js/*.js, UMD), evaluated
// as classic scripts so their globals are this module's exports.
//
// js/progress.js keeps the device's local board in `localStorage`: here that
// is a small shim over the device's starhermit:storage, installed before the
// scripts run. Progress itself is the game's save (platform.ts).
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rules.js", "js/content.js", "js/ai.js", "js/progress.js", "js/session.js", "js/strings.js", "js/i18n.js", "js/platform-strings.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type DrawRule = "until-playable" | "one" | "none";
export interface Ruleset { targetScore: number; maxRounds?: number; drawRule?: DrawRule; moveLimit?: number; maxPip?: number; handSize?: number }
export interface SeatCfg { id: string; name: string; kind: "human" | "ai"; difficulty?: string }
export interface MatchConfig { seed: string; ruleset: Ruleset; players: SeatCfg[]; custom?: unknown }
export interface Player { id: string; name: string; kind: "human" | "ai"; difficulty?: string; score: number; plays: number; draws: number; invalidActions: number }
export interface ChainTile { id: number; left: number; right: number }
export interface State {
  phase: "active" | "round-over" | "match-over"; turn: number; round: number; tick: number;
  players: Player[]; hands: number[][]; boneyard: number[]; chain: ChainTile[];
  leftEnd: number | null; rightEnd: number | null; ruleset: Required<Ruleset>;
  roundResult: RoundResult | null; terminal: Terminal | null;
}
export interface RoundResult { reason: "domino" | "blocked"; winners: number[]; pipTotals: number[]; breakdown: { player: number; points: number }[] }
export interface Terminal { reason: string; ranking: { player: number; score: number }[]; winner: number; scores: number[]; rounds: number; ticks: number; tied: boolean }
export interface Cmd { type: "play" | "draw" | "pass"; tileId?: number; end?: "left" | "right" }
export interface Tutorial {
  id: string; title: string; intro: string; outro: string; seed?: string;
  setup: { ruleset: Ruleset; players: SeatCfg[] };
  steps: { text: string; highlight?: { tileId?: number } | null; expect: { type: string; tileId?: number; end?: string } }[];
}
export interface Stage { id: string; number: number; name: string; blurb?: string; players: number; ai: string[]; targetScore: number; drawRule?: DrawRule; maxRounds?: number; moveLimit?: number; mastery?: boolean; theme: string; seed: string; par?: { rounds: number } }
export interface Challenge { id: string; name: string; goal: string; players: number; ai: string[]; ruleset: Ruleset; timeLimitSec?: number; theme: string; seed: string }
export interface Daily { id: string; kind: "daily"; dateKey: string; name: string; seed: string; theme: string; players: number; ai: string[]; ruleset: Ruleset; goal: string }
export type Content = Stage | Challenge | Daily | Tutorial | { id: string; name: string; kind?: string; goal?: string; blurb?: string; timeLimitSec?: number; number?: number };
export interface Theme {
  id: string; name: string; exposure?: number; lightBoost?: number;
  table: number; felt: number; tileBody: number; tileEdge: number; pip: number; accent: number; accent2: number; wall: number; fog: number; cupColor: number;
  css: { bg: string; panel: string; text: string; accent: string; good: string; bad: string };
}
export interface View {
  chain: { id: number; a: number; b: number; double: boolean; left: number; right: number }[];
  leftEnd: number | null; rightEnd: number | null; boneyardCount: number;
  myHand: number[]; tileFaces: Record<number, [number, number]>;
  opponents: { name: string; count: number; score: number; isTurn: boolean; kind: string }[];
  opponentPositions: { x: number; z: number; rotY: number }[];
  players: { name: string; score: number; isTurn: boolean; isMe: boolean; handCount: number; plays: number }[];
  hotseat: boolean; myName: string; myTurn: boolean; legalEnds: ("left" | "right")[]; selectedPlayable: boolean;
  selectedTile: number | null; playableTiles: Record<number, ("left" | "right")[]>; canDraw: boolean; canPass: boolean;
  phase: string; round: number; tick: number; targetScore: number; turnName: string; ruleset: Required<Ruleset>; elapsedMs: number;
  tutorial: { text: string; highlight: { tileId?: number } | null; index: number; total: number } | null;
}
export interface Achievement { key: string; name: string; desc: string }
export interface Progress {
  journey: Record<string, { stars: number; bestScore: number }>; tutorials: string[]; achievements: Record<string, number>;
  stats: { matches: number; wins: number; streak: number; bestStreak: number; rounds: number; dominos: number };
  daily: Record<string, { score: number; won: boolean }>; masteryXP: number;
}
export interface SavedMatch { mode: string; content: Content | null; config: MatchConfig; stateJson: string; elapsedMs: number }
export interface Doc { v: number; profile: { name: string; guest: boolean }; progress: Progress; savedMatch: SavedMatch | null }
export interface BoardEntry { name: string; score: number; mode: string; durationMs: number; won: boolean; at: number; contentId: string }
export interface Results {
  terminal: Terminal; won: boolean; me: number; roundResult: RoundResult | null; players: Player[];
  entry: { score: number; won: boolean; mode: string; durationMs: number }; unlocked: Achievement[]; stars: number; elapsedMs: number;
  replay: { seed: string };
}
export interface Store {
  readonly doc: Doc; readonly progress: Progress; readonly profile: Doc["profile"];
  readonly settings: Record<string, unknown> & { timingAssist: boolean; reducedMotion: boolean };
  saveNow(): void; now(): number;
}

export interface SessionInstance {
  state: State | null; mode: string | null; content: Content | null; config: MatchConfig | null;
  options: { undo: boolean; hints: boolean; ranked: boolean; timeLimitSec: number };
  paused: boolean; selectedTile: number | null; hotseat: boolean; _finished: boolean; _elapsedMs: number;
  _replay: { seed: string };
  renderer: unknown;
  onView: ((v: View | null) => void) | null;
  onAnnounce: ((text: string, kind: string) => void) | null;
  onEvent: ((name: string, payload: unknown) => void) | null;
  startMatch(mode: string, content: Content | null, config: MatchConfig, options: SessionInstance["options"]): State;
  act(cmd: Cmd, actionId?: string): { ok: boolean; reason?: string };
  continueNextRound(): void;
  skipToSettled(): void;
  canUndo(): boolean;
  undo(): { ok: boolean };
  hint(): Cmd | null;
  pause(): void;
  resume(): void;
  leave(): void;
  advanceClock(ms: number): void;
  buildView(): View | null;
  selectTile(id: number): void;
  _emitView(instant?: boolean): void;
  _maybeRunAI(): void;
  _humanIndex(): number;
}
interface SessionCtor {
  new (opts: { store: Store; audio: unknown; timers: { setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void }; externalClock: boolean }): SessionInstance;
}

interface RulesApi {
  serialize(s: State): string;
  deserialize(json: string): State;
  tileSet(maxPip: number): { a: number; b: number; double: boolean }[];
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; TUTORIALS: Tutorial[]; JOURNEY: Stage[]; CHALLENGES: Challenge[];
  stageToConfig(s: Stage, name: string): MatchConfig;
  challengeToConfig(c: Challenge, name: string): MatchConfig;
  dailyForDate(d: Date): Daily;
  dailyToConfig(d: Daily, name: string): MatchConfig;
  practiceConfig(o: { players: number; difficulty: string; targetScore: number; drawRule: string; seed?: string }, name: string): MatchConfig;
  dailyNameText(d: Daily, tr: (k: string, v?: Record<string, string | number>) => string): string;
  dailyGoalText(d: Daily, tr: (k: string, v?: Record<string, string | number>) => string): string;
  themeById(id: string): Theme;
}
interface ProgressApi {
  SAVE_VERSION: number;
  normalize(d: unknown): Doc;
  docFromSave(d: unknown): Doc | null;
  mergeDocs(remote: Doc | null, local: Doc | null): Doc;
  fromBrowserSave(text: string | null): { doc: Doc | null; settings: Record<string, unknown> | null };
  GAME_SETTING_KEYS: string[]; BROWSER_SETTING_KEYS: string[];
  DEFAULT_SETTINGS: Record<string, unknown>;
  checkSetting(key: string, v: unknown): unknown;
  ACHIEVEMENTS: Achievement[];
  localBoard(): BoardEntry[];
}
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
interface PlatformStringsApi {
  platformStrings(lang: string): Record<string, string>;
  fmtPlatform(s: string, vars?: Record<string, string | number>): string;
}

const g = globalThis as unknown as {
  ChainDominoesRules: RulesApi; ChainDominoesContent: ContentApi; ChainDominoesProgress: ProgressApi;
  ChainDominoesSession: { Session: SessionCtor }; CDMI18N: I18nApi; PlatformStrings: PlatformStringsApi;
};
export const Rules = g.ChainDominoesRules;
export const Content = g.ChainDominoesContent;
export const ProgressLib = g.ChainDominoesProgress;
export const Session = g.ChainDominoesSession.Session;
export const I18n = g.CDMI18N;
export const PlatformStrings = g.PlatformStrings;
