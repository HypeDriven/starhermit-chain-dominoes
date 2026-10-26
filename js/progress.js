/* Chain Dominoes — progress, achievements, the device's local board, and the
 * save document (pure: no DOM, no engine calls; UMD, so the Node tests and
 * the engine client (native/classic.ts, loadClassic) run the same code).
 *
 * The engine save (starhermit:storage `saves`) is
 *   { v: 1, profile: { name, guest }, progress, savedMatch }
 * — the browser build's save document without its settings (those are the
 * runtime's Options and the game's own settings now) and without its
 * checksum envelope (the engine keeps the save whole). Two devices' copies
 * merge with mergeProgress (journey stars and best scores, every finished
 * lesson, the earliest unlock of each achievement, the larger stats and
 * mastery XP, the better daily result), each device keeping its own
 * resumable match unless it has none.
 *
 * The browser build's cloud save (slot game:chain-dominoes, the JS SDK's
 * zipped save.json) is the text of { checksum, payload } where payload is
 * the JSON of its whole document; the engine shows it as a foreign save
 * whose text fromBrowserSave reads.
 *
 * Browser global: ChainDominoesProgress.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesProgress = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const SAVE_VERSION = 1;

  /* --------------------------------------------------------- checksum */
  /** FNV-1a of a string, as the browser build checksummed its save. */
  function checksum(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  function defaultProgress() {
    return {
      journey: {},                   // stageId -> {stars, bestScore}
      tutorials: [],                 // completed tutorial ids
      achievements: {},              // key -> unlock timestamp (idempotent)
      stats: { matches: 0, wins: 0, streak: 0, bestStreak: 0, rounds: 0, dominos: 0 },
      daily: {},                     // dateKey -> {score, won}
      masteryXP: 0,
    };
  }

  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** A save document with every part present. */
  function normalize(doc) {
    const d = obj(doc) || {};
    const p = obj(d.progress) || {};
    const base = defaultProgress();
    const progress = {
      journey: Object.assign({}, obj(p.journey) || {}),
      tutorials: Array.isArray(p.tutorials) ? p.tutorials.filter((t) => typeof t === 'string') : [],
      achievements: Object.assign({}, obj(p.achievements) || {}),
      stats: Object.assign(base.stats, obj(p.stats) || {}),
      daily: Object.assign({}, obj(p.daily) || {}),
      masteryXP: Number(p.masteryXP) || 0,
    };
    const prof = obj(d.profile) || {};
    const name = typeof prof.name === 'string' && prof.name.trim() ? prof.name.trim().slice(0, 24) : 'Guest';
    const sm = obj(d.savedMatch);
    return {
      v: SAVE_VERSION,
      profile: { name, guest: true },
      progress,
      savedMatch: sm && typeof sm.stateJson === 'string' && typeof sm.mode === 'string' ? clone(sm) : null,
    };
  }

  /** The document in an engine save, or null. */
  function docFromSave(data) {
    const d = obj(data);
    return d && d.v === SAVE_VERSION ? normalize(d) : null;
  }

  /** Mutates and returns `a` with the better of each record from `b`. */
  function mergeProgress(a, b) {
    a.journey = a.journey || {};
    Object.keys(b.journey || {}).forEach((id) => {
      const l = a.journey[id] || {}, r = b.journey[id] || {};
      a.journey[id] = Object.assign({}, l, r, {
        stars: Math.max(l.stars || 0, r.stars || 0),
        bestScore: Math.max(l.bestScore || 0, r.bestScore || 0),
      });
    });
    a.tutorials = Array.from(new Set([...(a.tutorials || []), ...(b.tutorials || [])]));
    a.achievements = a.achievements || {};
    Object.keys(b.achievements || {}).forEach((k) => {
      a.achievements[k] = a.achievements[k] ? Math.min(a.achievements[k], b.achievements[k]) : b.achievements[k];
    });
    a.stats = a.stats || {};
    Object.keys(b.stats || {}).forEach((k) => { a.stats[k] = Math.max(Number(a.stats[k]) || 0, Number(b.stats[k]) || 0); });
    a.daily = a.daily || {};
    Object.keys(b.daily || {}).forEach((key) => {
      const l = a.daily[key], r = b.daily[key];
      a.daily[key] = !l ? r : Object.assign({}, l, { score: Math.max(l.score || 0, r.score || 0), won: !!(l.won || r.won) });
    });
    a.masteryXP = Math.max(a.masteryXP || 0, b.masteryXP || 0);
    return a;
  }

  /**
   * Two documents merged (either may be null): the better of every record;
   * `local` keeps its profile name (unless it is the default) and its
   * resumable match (unless it has none).
   */
  function mergeDocs(remote, local) {
    if (!remote && !local) return normalize({});
    if (!remote) return normalize(local);
    if (!local) return normalize(remote);
    const r = normalize(remote), l = normalize(local);
    const out = normalize(l);
    mergeProgress(out.progress, r.progress);
    if (out.profile.name === 'Guest' && r.profile.name !== 'Guest') out.profile.name = r.profile.name;
    if (!out.savedMatch && r.savedMatch) out.savedMatch = r.savedMatch;
    return out;
  }

  /** The browser build's wrapped save text → { doc, settings } (either may be null). */
  function fromBrowserSave(text) {
    if (typeof text !== 'string') return { doc: null, settings: null };
    let inner = null;
    try {
      const env = JSON.parse(text);
      if (obj(env) && typeof env.payload === 'string' && env.checksum === checksum(env.payload)) inner = JSON.parse(env.payload);
      else if (obj(env) && obj(env.progress)) inner = env; // an unwrapped document
    } catch (e) { inner = null; }
    if (!obj(inner)) return { doc: null, settings: null };
    const doc = obj(inner.progress) ? normalize(inner) : null;
    // A hosted browser build replaced the guest name with the account's: not the guest's own.
    if (doc && obj(inner.profile) && inner.profile.guest === false) doc.profile.name = 'Guest';
    return { doc, settings: obj(inner.settings) ? gameSettingsFrom(inner.settings) : null };
  }

  /* ----------------------------------------------------------- settings */
  const bool = (v) => typeof v === 'boolean';
  const THEME_IDS = ['ceramic-classic', 'midnight-espresso', 'sage-garden', 'terracotta-sun', 'mono-ink'];
  /** The game's own settings (game.<key> in the runtime's settings) with their checks. */
  const GAME_SETTINGS = {
    theme: (v) => THEME_IDS.indexOf(v) >= 0,
    showNumbers: bool,
    colorVision: (v) => ['none', 'protanopia', 'deuteranopia', 'tritanopia'].indexOf(v) >= 0,
    leftHanded: bool,
    holdToConfirm: bool,
    timingAssist: bool,
    haptics: bool,
    hints: bool,
    undo: bool,
  };
  const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
  const DEFAULT_SETTINGS = Object.freeze({
    theme: 'ceramic-classic', showNumbers: false, colorVision: 'none', leftHanded: false,
    holdToConfirm: false, timingAssist: false, haptics: true, hints: true, undo: true,
  });
  /**
   * The keys the browser build kept in the account's per-player settings
   * (its SYNCED_SETTINGS). Those that are the game's own settings carry over;
   * the rest (graphics, volumes, mute, reduced motion, contrast, text size,
   * camera preset) are the runtime's Options now. All are removed once read.
   */
  const BROWSER_SETTING_KEYS = ['theme', 'quality', 'gfx', 'volumes', 'muted', 'reducedMotion', 'highContrast', 'largeText',
    'leftHanded', 'showNumbers', 'colorVision', 'holdToConfirm', 'timingAssist', 'haptics', 'hints', 'undo', 'cameraPreset'];

  /** A value for one of the game's settings, or undefined when it is not one. */
  function checkSetting(key, value) {
    const check = GAME_SETTINGS[key];
    return check && check(value) ? value : undefined;
  }
  /** The game's settings found in a browser-build settings object. */
  function gameSettingsFrom(settings) {
    const s = obj(settings) || {};
    const out = {};
    GAME_SETTING_KEYS.forEach((k) => { if (checkSetting(k, s[k]) !== undefined) out[k] = s[k]; });
    return out;
  }

  /* -------------------------------------------------------- achievements */
  const ACHIEVEMENTS = [
    { key: 'first_win', name: 'First Domino', desc: 'Win your first match.' },
    { key: 'mechanic_mastery', name: 'House Student', desc: 'Complete every tutorial lesson.' },
    { key: 'streak_5', name: 'Regular', desc: 'Win 5 matches in a row.' },
    { key: 'milestone_hard', name: 'Barista\'s Table', desc: 'Beat a hard mastery stage (32 or later).' },
    { key: 'marathon_100', name: 'Bottomless', desc: 'Play 100 matches. Any mode, any pace.' },
    { key: 'daily_7', name: 'Seven Days of Coffee', desc: 'Finish 7 daily tables.' },
    { key: 'journey_complete', name: 'Café Champion', desc: 'Win all 40 journey stages.' },
  ];

  /** Unlocks an achievement once (the store's progress); its definition when newly unlocked. */
  function unlock(store, key) {
    const def = ACHIEVEMENTS.find(a => a.key === key);
    if (!def) return null;
    if (store.progress.achievements[key]) return null; // idempotent
    store.progress.achievements[key] = store.now ? store.now() : Date.now();
    store.saveNow();
    return def;
  }

  /* ----------------------------------------------------------- telemetry */
  // The browser build kept consent-gated funnel events in memory only (no
  // endpoint took them); the engine client has no telemetry. The session
  // still reports its events here.
  const telemetry = { event() { /* none */ } };

  /* --------------------------------------------------- local leaderboard */
  // The device's own board (as the browser build kept it in localStorage:
  // on the engine a shim over the device's storage). Entries carry the
  // ruleset, seed, assists and duration of the finished ranked match.
  const LB_KEY = 'chaindominoes.localboard.v1';
  function storageOf() { return root.localStorage || null; }
  function localBoard() {
    try { const s = storageOf(); return JSON.parse((s && s.getItem(LB_KEY)) || '[]'); } catch (e) { return []; }
  }
  function localSubmit(entry) {
    const board = localBoard();
    board.push(entry);
    board.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
    try { const s = storageOf(); if (s) s.setItem(LB_KEY, JSON.stringify(board.slice(0, 100))); } catch (e) { /* full */ }
    return board;
  }

  return {
    SAVE_VERSION, checksum, defaultProgress, normalize, docFromSave, mergeProgress, mergeDocs, fromBrowserSave,
    GAME_SETTINGS, GAME_SETTING_KEYS, DEFAULT_SETTINGS, BROWSER_SETTING_KEYS, checkSetting, gameSettingsFrom,
    ACHIEVEMENTS, unlock, telemetry, localBoard, localSubmit,
  };
});
