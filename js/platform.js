/* Chain Dominoes — platform layer.
 * Local persistence (versioned, checksummed save document), settings,
 * achievements, local leaderboards, anonymous funnel telemetry (consent
 * gated), and the StarHermit host adapter. When no host shell is present
 * every host call degrades gracefully and the game remains fully playable.
 *
 * Never persists access/launch tokens in local storage.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesPlatform = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : globalThis;

  const SAVE_VERSION = 1;
  const LS_KEY = 'chaindominoes.save.v1';
  const LS_CONSENT = 'chaindominoes.telemetry-consent';

  /* --------------------------------------------------------- checksum */
  function checksum(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  function defaultDoc() {
    return {
      version: SAVE_VERSION,
      profile: { name: 'Guest', avatar: null, guest: true },
      settings: {
        theme: 'ceramic-classic',
        quality: 'auto',               // auto | low | medium | high
        volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 },
        muted: false,
        reducedMotion: false,
        highContrast: false,
        largeText: false,
        leftHanded: false,
        showNumbers: false,            // numeric labels on tiles (a11y)
        colorVision: 'none',           // none | protanopia | deuteranopia | tritanopia
        holdToConfirm: false,          // hold-versus-toggle
        timingAssist: false,           // extended challenge timers
        haptics: true,
        hints: true,
        undo: true,
        cameraPreset: 'default',
        bindings: {                    // desktop action bindings (overridable)
          navLeft: 'ArrowLeft', navRight: 'ArrowRight', navUp: 'ArrowUp', navDown: 'ArrowDown',
          confirm: 'Enter', cancel: 'Escape', pause: 'KeyP', undo: 'KeyU', hint: 'KeyH',
          cameraReset: 'KeyC', endLeft: 'KeyA', endRight: 'KeyD', draw: 'KeyW', pass: 'KeyS',
        },
      },
      progress: {
        journey: {},                   // stageId -> {stars, bestScore}
        tutorials: [],                 // completed tutorial ids
        achievements: {},              // key -> unlock timestamp (idempotent)
        stats: { matches: 0, wins: 0, streak: 0, bestStreak: 0, rounds: 0, dominos: 0 },
        daily: {},                     // dateKey -> {score, won, rank}
        masteryXP: 0,
      },
      savedMatch: null,                // resumable local snapshot
      updatedAt: 0,
    };
  }

  /* ------------------------------------------------------------- store */
  class Store {
    constructor() {
      this.doc = defaultDoc();
      this._loadLocal();
      this._conflict = null; // {local, remote} preserved for player choice
    }
    _loadLocal() {
      try {
        const raw = root.localStorage ? localStorage.getItem(LS_KEY) : null;
        if (!raw) return;
        const env = JSON.parse(raw);
        if (!env || env.checksum !== checksum(env.payload)) return; // corrupt -> fresh
        const doc = JSON.parse(env.payload);
        if (doc.version !== SAVE_VERSION) { this._migrate(doc); }
        this.doc = Object.assign(defaultDoc(), doc);
        this.doc.settings = Object.assign(defaultDoc().settings, doc.settings);
        this.doc.progress = Object.assign(defaultDoc().progress, doc.progress);
      } catch (e) { /* fresh start */ }
    }
    _migrate(doc) {
      // v0 -> v1 migration point; currently just re-version.
      doc.version = SAVE_VERSION;
    }
    saveNow() {
      this.doc.updatedAt = Date.now();
      const payload = JSON.stringify(this.doc);
      try {
        if (root.localStorage)
          localStorage.setItem(LS_KEY, JSON.stringify({ checksum: checksum(payload), payload }));
      } catch (e) { /* storage full/blocked: session continues in memory */ }
      this._cloudPush();
    }
    get settings() { return this.doc.settings; }
    get progress() { return this.doc.progress; }
    get profile() { return this.doc.profile; }
    get conflict() { return this._conflict; }

    /* Cloud save via host, when available. Conflict: keep both, ask player. */
    async cloudLoad() {
      if (!host.present) return null;
      try {
        const res = await host.api('/api/v1/games/' + host.scope + '/save');
        if (!res || !res.payload) return null;
        if (res.checksum !== checksum(res.payload)) return null;
        const remote = JSON.parse(res.payload);
        if (remote.updatedAt > this.doc.updatedAt && remote.version === SAVE_VERSION) {
          // strict descendant heuristic: remote strictly newer -> conflict ask
          this._conflict = { local: this.doc, remote };
          return this._conflict;
        }
      } catch (e) { /* offline */ }
      return null;
    }
    resolveConflict(choice) {
      if (!this._conflict) return;
      if (choice === 'remote') {
        this.doc = this._conflict.remote;
        this.saveNow();
      } // 'local': keep local, next saveNow pushes it
      this._conflict = null;
    }
    async _cloudPush() {
      if (!host.present) return;
      try {
        const payload = JSON.stringify(this.doc);
        await host.api('/api/v1/games/' + host.scope + '/save', {
          method: 'PUT',
          body: JSON.stringify({ version: SAVE_VERSION, checksum: checksum(payload), payload }),
        });
      } catch (e) { /* retry on next save */ }
    }
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

  function unlock(store, key) {
    const def = ACHIEVEMENTS.find(a => a.key === key);
    if (!def) return null;
    if (store.progress.achievements[key]) return null; // idempotent
    store.progress.achievements[key] = Date.now();
    store.saveNow();
    return def;
  }

  /* ----------------------------------------------------------- telemetry */
  // Anonymous funnel events only, consent gated, random session id,
  // never raw text/personal data. Offline: kept in-memory only.
  const telemetry = {
    sessionId: Math.random().toString(36).slice(2) + Date.now().toString(36),
    queue: [],
    get consent() {
      try { return root.localStorage && localStorage.getItem(LS_CONSENT) === 'yes'; }
      catch (e) { return false; }
    },
    setConsent(v) {
      try { if (root.localStorage) localStorage.setItem(LS_CONSENT, v ? 'yes' : 'no'); } catch (e) { /* ok */ }
    },
    event(name, data) {
      const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
      if (allowed.indexOf(name) < 0) return;
      if (!this.consent) return;
      const payload = { name, at: Date.now(), sid: this.sessionId, data: data || {} };
      this.queue.push(payload);
      if (host.present) {
        host.api('/api/v1/telemetry', { method: 'POST', body: JSON.stringify(payload) })
          .catch(() => {});
      }
    },
  };

  /* ------------------------------------------------------------ host API */
  // StarHermit shell integration. Scope comes from the short-lived launch
  // token (never stored). All calls fail soft when hosted routes are absent.
  const host = {
    present: false,
    scope: null,
    _token: null,
    _timeOffset: 0,
    init() {
      // Host shell injects window.__STARHERMIT__ = { launchToken, scopeHint }.
      const shim = root.__STARHERMIT__;
      if (shim && shim.launchToken) {
        this.present = true;
        this._token = shim.launchToken;
        try {
          const payload = JSON.parse(atob(shim.launchToken.split('.')[1] || ''));
          this.scope = payload.game || payload.scope || shim.scopeHint || null;
        } catch (e) { this.scope = shim.scopeHint || null; }
        if (!this.scope) this.scope = 'chain-dominoes';
        this.syncTime();
        return true;
      }
      // Same-origin probe: if /api/v1/time answers, we are hosted.
      if (root.fetch && typeof root.location === 'object' && root.location &&
          (root.location.protocol === 'http:' || root.location.protocol === 'https:')) {
        this.syncTime(true);
      }
      return false;
    },
    async syncTime(probe) {
      try {
        const t0 = Date.now();
        const res = await fetch('/api/v1/time', { headers: this._headers() });
        if (!res.ok) return;
        const body = await res.json();
        const t1 = Date.now();
        if (typeof body.now === 'number') {
          this._timeOffset = body.now - (t0 + (t1 - t0) / 2);
          if (probe && !this.present) this.present = true;
        }
      } catch (e) { /* local clock */ }
    },
    now() { return Date.now() + this._timeOffset; },
    _headers() {
      const h = { 'Content-Type': 'application/json' };
      if (this._token) h.Authorization = 'Bearer ' + this._token;
      return h;
    },
    async api(path, opts) {
      const res = await fetch(path, Object.assign({ headers: this._headers() }, opts || {}));
      if (res.status === 429) { // rate limited: recoverable UI state
        const err = new Error('rate-limited'); err.code = 'rate-limited'; throw err;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || (body && body.error)) {
        const err = new Error((body && body.error) || ('http-' + res.status));
        err.code = (body && body.error) || res.status;
        throw err;
      }
      return body;
    },
    async refreshToken() {
      if (!this.present) return null;
      const res = await this.api('/api/v1/auth/refresh', { method: 'POST' });
      if (res && res.token) { this._token = res.token; return res.token; } // memory only
      return null;
    },
    async submitScore(entry) {
      if (!this.present) return { ok: false, reason: 'offline' };
      return this.api('/api/v1/games/' + (this.scope || 'chain-dominoes') + '/scores', {
        method: 'POST', body: JSON.stringify(entry),
      });
    },
    async fetchLeaderboard(kind) {
      if (!this.present) return { entries: [], local: true };
      return this.api('/api/v1/games/' + (this.scope || 'chain-dominoes') + '/leaderboards/' + kind);
    },
    heartbeat() {
      if (!this.present) return;
      this.api('/api/v1/presence', { method: 'POST', body: JSON.stringify({ game: this.scope }) })
        .catch(() => {});
    },
    startActivity() {
      if (!this.present) return;
      this._activityAt = Date.now();
      this.api('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ game: this.scope }) }).catch(() => {});
    },
    endActivity() {
      if (!this.present || !this._activityAt) return;
      const mins = Math.round((Date.now() - this._activityAt) / 60000);
      this._activityAt = null;
      this.api('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ game: this.scope, minutes: mins }) }).catch(() => {});
    },
  };

  /* --------------------------------------------------- local leaderboard */
  // Local board used offline; entries carry ruleset/seed/assists/duration
  // exactly like server submissions.
  const LB_KEY = 'chaindominoes.localboard.v1';
  function localBoard() {
    try { return JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch (e) { return []; }
  }
  function localSubmit(entry) {
    const board = localBoard();
    board.push(entry);
    board.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
    try { localStorage.setItem(LB_KEY, JSON.stringify(board.slice(0, 100))); } catch (e) { /* ok */ }
    return board;
  }

  return { Store, ACHIEVEMENTS, unlock, telemetry, host, localBoard, localSubmit, checksum };
});
