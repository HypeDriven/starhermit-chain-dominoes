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
      this._cloudBusy = false; // cloud compare in flight: pushes are deferred
      this._pushDeferred = false;
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
      host.mirrorSettings(this.doc.settings);
    }
    get settings() { return this.doc.settings; }
    get progress() { return this.doc.progress; }
    get profile() { return this.doc.profile; }
    get conflict() { return this._conflict; }

    /* Cloud save via the platform slot (GET/PUT /api/v1/me/cloud-saves/{slug},
     * zip+base64, one slot). Conflict: keep both, ask player. localStorage
     * stays the offline cache. */
    async cloudLoad() {
      if (!host.present) return null;
      // Compare against the local copy as it was at launch: boot writes made
      // while the load is in flight (account nickname, settings KV) bump
      // updatedAt and must not make a stale local doc look newer. Their
      // pushes wait for the compare and stay held while a conflict is open.
      const base = this.doc.updatedAt;
      this._cloudBusy = true;
      try {
        const wrapped = await host.cloudLoadRaw();
        if (!wrapped) return null;
        const env = JSON.parse(wrapped);
        if (!env || env.checksum !== checksum(env.payload)) return null;
        const remote = JSON.parse(env.payload);
        if (remote.updatedAt > base && remote.version === SAVE_VERSION) {
          // strict descendant heuristic: remote strictly newer -> conflict ask
          this._conflict = { local: this.doc, remote };
          return this._conflict;
        }
      } catch (e) { /* offline */ } finally {
        this._cloudBusy = false;
        if (this._pushDeferred && !this._conflict) this._cloudPush();
      }
      return null;
    }
    resolveConflict(choice) {
      if (!this._conflict) return;
      const remote = this._conflict.remote;
      this._conflict = null;
      if (choice === 'remote') {
        this.doc = remote;
        this.saveNow();
      } else {
        this._cloudPush(); // keep local: it replaces the cloud doc now
      }
    }
    _cloudPush() {
      if (!host.present) return;
      if (this._cloudBusy || this._conflict) { this._pushDeferred = true; return; }
      this._pushDeferred = false;
      try {
        const payload = JSON.stringify(this.doc);
        host.cloudPush(JSON.stringify({ checksum: checksum(payload), payload }));
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
      // No client telemetry endpoint exists for launch tokens (wiki) —
      // consent-gated funnel events stay in-memory only.
    },
  };

  /* ------------------------------------------------------------ host API */
  // StarHermit host integration over window.StarHermit (starhermit-sdk.js,
  // loaded and init()ed from index.html before this file). The SDK reads the
  // launch token (#game_token / #access_token, stripped, memory only), renews
  // it, and owns profile, cloud save (slot game:<slug>), settings KV,
  // controls, leaderboards, matchmaking, invite link and sign-in. Standalone
  // (no token) every call resolves locally and nothing touches the network.
  const SAVE_DEBOUNCE_MS = 2000;
  const sdk = () => root.StarHermit || null;
  const SYNCED_SETTINGS = ['theme', 'quality', 'gfx', 'volumes', 'muted', 'reducedMotion', 'highContrast', 'largeText',
    'leftHanded', 'showNumbers', 'colorVision', 'holdToConfirm', 'timingAssist', 'haptics', 'hints', 'undo', 'cameraPreset'];

  const host = {
    profile: { name: 'Guest', guest: true },
    sync: 'offline',       // offline | saving | synced (cloud mirror)
    bindings: null,        // { action: [codes] } resolved by loadBindings
    _codeMap: null,
    _timeOffset: 0,
    _syncListeners: [],
    _authListeners: [],
    _hooked: false,
    _settingsTimer: null,
    _settingsLoaded: false,
    _lastSettings: null,

    get present() { const s = sdk(); return !!(s && s.signedIn); },
    get scope() { const s = sdk(); return s ? s.slug : null; },
    get userId() { const s = sdk(); return s ? s.userId : null; },

    init() {
      const s = sdk();
      if (s && !this._hooked) {
        this._hooked = true;
        s.on('saved', (ok) => this._setSync(ok ? 'synced' : 'offline'));
        s.on('auth', (a) => {
          if (!a.signedIn) { this.profile = { name: 'Guest', guest: true }; this._setSync('offline'); }
          this._authListeners.forEach((fn) => { try { fn(a); } catch (e) { /* ok */ } });
        });
      }
      if (this.present) {
        try {
          root.addEventListener('pagehide', () => this.flushCloudSave());
          document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushCloudSave(); });
        } catch (e) { /* no window events available */ }
        this.fetchProfile().catch(() => {});
      }
      return this.present;
    },
    onAuth(fn) { if (typeof fn === 'function') this._authListeners.push(fn); },
    canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); },
    signIn() { const s = sdk(); return !!(s && s.signIn()); },
    inviteLink() { const s = sdk(); return s && s.signedIn ? s.inviteLink() : null; },
    async copyInvite() {
      const link = this.inviteLink();
      if (!link) return false;
      try { await navigator.clipboard.writeText(link); return true; } catch (e) { return false; }
    },

    /** Authenticated JSON call through the SDK (null when signed out). */
    api(path, opts) {
      const s = sdk();
      if (!s || !s.signedIn) return Promise.resolve(null);
      const o = Object.assign({}, opts || {});
      if (typeof o.body === 'string') { try { o.body = JSON.parse(o.body); } catch (e) { /* keep */ } }
      return s.api(path, o).catch((e) => {
        const err = new Error((e && e.message) || 'request-failed');
        err.code = e && e.status === 429 ? 'rate-limited' : (e && e.status);
        throw err;
      });
    },
    gamePath(suffix) { const s = sdk(); return s ? s.gamePath(suffix) : ''; },
    refreshToken() { const s = sdk(); return s ? s.refresh() : Promise.resolve(null); },

    /* Identity: the profile nickname (never /api/v1/me, never usernames). */
    profileFor(userId) {
      if (!userId || typeof userId !== 'string') return Promise.resolve('player');
      const s = sdk();
      if (!s || !s.signedIn) return Promise.resolve('Player ' + userId.slice(0, 6));
      return s.profile(userId).then((p) => (p && p.displayName) || 'Player ' + userId.slice(0, 6))
        .catch(() => 'Player ' + userId.slice(0, 6));
    },
    async fetchProfile() {
      if (!this.userId) return null;
      const name = (await this.profileFor(this.userId)).slice(0, 40);
      this.profile = { name, guest: false };
      return this.profile;
    },

    /* Cloud save: the SDK slot game:<slug> holds the checksummed wrapped
     * doc string; the local doc is the offline cache. */
    cloudLoadRaw() {
      if (!this.present) return Promise.resolve(null);
      return sdk().loadSave().catch(() => null);
    },
    cloudPush(wrapped) {
      if (!this.present) return;
      this._setSync('saving');
      sdk().saveJSON(JSON.parse(wrapped), SAVE_DEBOUNCE_MS);
    },
    flushCloudSave() {
      if (!this.present) return Promise.resolve(false);
      return sdk().flushSave(true);
    },
    onSync(fn) { if (typeof fn === 'function') this._syncListeners.push(fn); },
    _setSync(state) {
      if (this.sync === state) return;
      this.sync = state;
      this._syncListeners.forEach((fn) => { try { fn(state); } catch (e) { /* ok */ } });
    },

    /* Settings KV: player preferences (not bindings — those use controls). */
    pickSettings(settings) {
      const out = {};
      SYNCED_SETTINGS.forEach((k) => { if (settings && settings[k] !== undefined) out[k] = settings[k]; });
      return out;
    },
    getSettings() {
      if (!this.present) return Promise.resolve({});
      return sdk().getSettings().then((kv) => {
        const out = this.pickSettings(kv || {});
        this._settingsLoaded = true;
        return out;
      }, () => { this._settingsLoaded = true; return {}; });
    },
    /** Debounced patch of changed preferences. */
    mirrorSettings(settings) {
      if (!this.present || !this._settingsLoaded) return; // never overwrite before the KV was read
      const patch = this.pickSettings(settings);
      const json = JSON.stringify(patch);
      if (json === this._lastSettings) return;
      clearTimeout(this._settingsTimer);
      this._settingsTimer = setTimeout(() => {
        this._lastSettings = json;
        sdk().patchSettings(patch).catch(() => {});
      }, 800);
    },
    patchSettings(obj) {
      if (!this.present) return Promise.resolve(null);
      return sdk().patchSettings(obj).catch(() => null);
    },

    /* Controls: defaults are { action: code } from the save doc. */
    loadBindings(defaults) {
      const d = {};
      Object.keys(defaults || {}).forEach((k) => { d[k] = [].concat(defaults[k]); });
      this.bindings = d; this._codeMap = null; // usable at once; platform overrides follow
      const s = sdk();
      const p = s && s.signedIn ? s.loadBindings(d).catch(() => d) : Promise.resolve(d);
      return p.then((b) => { this.bindings = b; this._codeMap = null; return b; });
    },
    actionFor(e) {
      if (!this.bindings) return null;
      if (!this._codeMap) {
        this._codeMap = {};
        Object.keys(this.bindings).forEach((a) => this.bindings[a].forEach((c) => { this._codeMap[c] = a; }));
      }
      return this._codeMap[e.code] || null;
    },
    keyLabel(action) {
      const codes = (this.bindings && this.bindings[action]) || [];
      return codes.map((c) => c.replace(/^Key|^Digit/, '').replace(/^Arrow/, '')).join(' / ') || '—';
    },

    /* Leaderboards are READ-ONLY for clients: the game's first platform
     * board, resolved to nicknames. No board (or offline) -> local records. */
    async fetchLeaderboard() {
      if (!this.present) return { entries: [], local: true };
      try {
        const res = await sdk().leaderboard(null, { pageSize: 20 });
        if (!res.board) return { entries: [], local: true, reason: 'no-leaderboard' };
        const entries = [];
        for (const e of (res.items || []).slice(0, 20)) {
          const uid = e.userId != null ? e.userId : e.playerId;
          entries.push({
            name: uid ? await this.profileFor(String(uid)) : (e.username || e.name || 'player'),
            score: e.score != null ? e.score : e.value,
          });
        }
        return { entries, local: false };
      } catch (e) {
        return { entries: [], local: true, reason: String(e.message || e) };
      }
    },

    /* Matchmaking through the platform queues (SDK). */
    async matchmakingJoin() {
      const s = sdk();
      if (!s || !s.signedIn) throw new Error('offline');
      const queues = await s.queues();
      const keys = (queues || []).map((q) => q && (q.key || q.id)).filter(Boolean);
      const ticket = await s.joinQueue(keys);
      return ticket || {};
    },
    /** Post a finished match score to the high-score board (score-script.js).
     * Resolves { posted, rank } — rank on the board, or null. Standalone: no call. */
    submitScore(total) {
      const s = sdk();
      if (!s || !s.signedIn) return Promise.resolve({ posted: false, rank: null });
      return s.submitScores({ 'high-score': total }).then((keys) => {
        if (keys.indexOf('high-score') < 0) return { posted: false, rank: null };
        return s.leaderboard('high-score', { pageSize: 100 }).then((r) => {
          const me = (r.items || []).filter((i) => i.userId === s.userId)[0];
          return { posted: true, rank: me ? me.rank : null };
        }, () => ({ posted: true, rank: null }));
      }, () => ({ posted: false, rank: null }));
    },
    matchmakingPoll() { const s = sdk(); return s ? s.matchStatus() : Promise.resolve(null); },
    matchmakingLeave() { const s = sdk(); return s ? s.cancelMatch() : Promise.resolve(null); },

    /* Clock: launch tokens reach no server-time route (the SDK lists every
     * endpoint), so the daily seed uses the local UTC date. */
    syncTime() { return Promise.resolve(); },
    now() { return Date.now() + this._timeOffset; },
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
