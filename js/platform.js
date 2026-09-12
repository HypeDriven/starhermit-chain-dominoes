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

    /* Cloud save via the platform slot (GET/PUT /api/v1/me/cloud-saves/{slug},
     * zip+base64, one slot). Conflict: keep both, ask player. localStorage
     * stays the offline cache. */
    async cloudLoad() {
      if (!host.present) return null;
      try {
        const wrapped = await host.cloudLoadRaw();
        if (!wrapped) return null;
        const env = JSON.parse(wrapped);
        if (!env || env.checksum !== checksum(env.payload)) return null;
        const remote = JSON.parse(env.payload);
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
    _cloudPush() {
      if (!host.present) return;
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
  // StarHermit host integration. The launch token arrives in the URL fragment
  // (#game_token=<jwt>, optional &session_id=), is stripped after the read,
  // and is kept in memory only — never persisted. The JWT carries sub =
  // user id and game_scope = this game's slug — never hard-coded. Every
  // hosted call fails soft when the platform routes are absent; offline
  // play never touches /api at all (a speculative probe 404s and logs a
  // console error on plain static servers, so there is none).
  const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
  const RETRY_MS = 60 * 1000;
  const SAVE_DEBOUNCE_MS = 2000;

  // Minimal ZIP writer/reader (stored entries only, no compression).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const host = {
    present: false,        // a launch token was read (hosted mode)
    scope: null,           // game slug from the JWT's game_scope
    userId: null,          // JWT sub
    profile: { name: 'Guest', guest: true },
    sync: 'offline',       // offline | saving | synced (cloud mirror)
    _token: null,
    _timeOffset: 0,
    _refreshTimer: null,
    _retryTimer: null,
    _saveTimer: null,
    _pendingSave: null,
    _profileNames: {},
    _syncListeners: [],
    _matchPollTimer: null,

    init() {
      this._token = this._readLaunchToken();
      if (this._token) {
        const claims = this._decodeJwt(this._token);
        if (!claims) this._token = null;
        else {
          if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
          if (typeof claims.game_scope === 'string' && claims.game_scope) this.scope = claims.game_scope;
          if (!this.userId || !this.scope) this._token = null;
        }
      }
      this.present = !!this._token;
      if (this.present) {
        this._scheduleRefresh();
        try {
          root.addEventListener('pagehide', () => this.flushCloudSave());
          document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushCloudSave(); });
        } catch (e) { /* no window events available */ }
        this.fetchProfile().catch(() => {});
      }
      return this.present;
    },

    // Fragment first (platform contract); query forms are local-dev only.
    _readLaunchToken() {
      try {
        const h = new URLSearchParams(String(root.location.hash || '').replace(/^#/, ''));
        const t = h.get('game_token');
        if (t) {
          h.delete('game_token');
          h.delete('session_id');
          const rest = h.toString();
          root.history.replaceState(null, '',
            root.location.pathname + root.location.search + (rest ? '#' + rest : ''));
          return t;
        }
        const q = new URLSearchParams(root.location.search);
        return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
      } catch (e) { return null; }
    },
    _decodeJwt(t) {
      try {
        const seg = String(t).split('.')[1];
        if (!seg) return null;
        let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
        b64 += '='.repeat((4 - (b64.length % 4)) % 4);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) { return null; }
    },

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
    gamePath(suffix) {
      return '/api/v1/games/' + encodeURIComponent(this.scope || 'chain-dominoes') + suffix;
    },

    /* Token refresh: scoped tokens may re-mint via the game's launch-token
     * route. Retry a failed re-mint after ~60 s. */
    _scheduleRefresh() {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
      this._refreshTimer = setInterval(() => this.refreshToken(), REFRESH_MS);
    },
    async refreshToken() {
      if (!this.present) return null;
      try {
        const res = await this.api(this.gamePath('/launch-token'), { method: 'POST', body: '{}' });
        if (res && res.token) { this._token = res.token; return res.token; } // memory only
      } catch (e) { /* schedule a retry below */ }
      if (!this._retryTimer) {
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.refreshToken();
        }, RETRY_MS);
      }
      return null;
    },

    /* Identity: the profile nickname is the only profile read a game-scoped
     * token may make (never /api/v1/me, never usernames). */
    profileFor(userId) {
      if (!userId || typeof userId !== 'string') return Promise.resolve('player');
      if (this._profileNames[userId]) return this._profileNames[userId];
      const p = this.api('/api/v1/users/' + encodeURIComponent(userId) + '/profile')
        .then((r) => (r && typeof r.nickname === 'string' && r.nickname ? r.nickname : null))
        .then((n) => n || ('Player ' + userId.slice(0, 8)))
        .catch(() => 'Player ' + userId.slice(0, 8));
      this._profileNames[userId] = p;
      return p;
    },
    async fetchProfile() {
      if (!this.userId) return null;
      const name = (await this.profileFor(this.userId)).slice(0, 40);
      this.profile = { name, guest: false };
      return this.profile;
    },

    /* Cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug}.
     * The checksummed local doc is the offline cache; this mirrors it. */
    async cloudLoadRaw() {
      if (!this.present) return null;
      try {
        const res = await fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(this.scope), { headers: this._headers() });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('http-' + res.status);
        const buf = await res.arrayBuffer();
        if (!buf || !buf.byteLength) return null;
        return new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf)));
      } catch (e) { return null; }
    },
    cloudPush(wrapped) {
      if (!this.present) return;
      this._pendingSave = wrapped;
      this._setSync('saving');
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.flushCloudSave(), SAVE_DEBOUNCE_MS);
    },
    flushCloudSave() {
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      if (!this.present || !this.scope || this._pendingSave == null) return Promise.resolve(false);
      const wrapped = this._pendingSave;
      this._pendingSave = null;
      let body;
      try {
        body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(wrapped))) };
      } catch (e) { return Promise.resolve(false); }
      return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(this.scope), {
        method: 'PUT', headers: this._headers(), body: JSON.stringify(body), keepalive: true,
      }).then((res) => {
        if (res.ok) { this._setSync('synced'); return true; }
        this._pendingSave = this._pendingSave == null ? wrapped : this._pendingSave;
        this._setSync('offline');
        return false;
      }).catch(() => {
        this._pendingSave = this._pendingSave == null ? wrapped : this._pendingSave;
        this._setSync('offline');
        return false;
      });
    },
    onSync(fn) { if (typeof fn === 'function') this._syncListeners.push(fn); },
    _setSync(state) {
      if (this.sync === state) return;
      this.sync = state;
      this._syncListeners.forEach((fn) => { try { fn(state); } catch (e) { /* ok */ } });
    },

    /* Leaderboards are READ-ONLY for clients (wiki): entries resolve through
     * the game record's leaderboardId. No leaderboardId -> local records. */
    async fetchLeaderboard() {
      if (!this.present) return { entries: [], local: true };
      try {
        const game = await this.api(this.gamePath(''));
        const leaderboardId = game && game.leaderboardId;
        if (!leaderboardId) return { entries: [], local: true, reason: 'no-leaderboard' };
        const res = await this.api('/api/v1/leaderboards/' + encodeURIComponent(leaderboardId) +
          '/entries?page=1&pageSize=20');
        const raw = (res && (res.entries || res.items)) || [];
        const entries = [];
        for (const e of raw.slice(0, 20)) {
          const uid = e.userId != null ? e.userId : e.playerId;
          entries.push({
            name: uid ? await this.profileFor(String(uid)) : (e.name || 'player'),
            score: e.score != null ? e.score : e.value,
          });
        }
        return { entries, local: false };
      } catch (e) {
        return { entries: [], local: true, reason: String(e.message || e) };
      }
    },

    /* Realtime lobby plumbing (platform games API): matchmaking tickets and
     * hosted table sockets carrying the game script's command envelope. The
     * local Session engine is not wired to hosted tables yet — the UI opens
     * the lobby honestly and labels table play as unavailable. */
    matchmakingJoin(options) {
      return this.api(this.gamePath('/matchmaking'), { method: 'POST', body: JSON.stringify(options || {}) });
    },
    matchmakingPoll(ticketId) {
      return this.api(this.gamePath('/matchmaking') + (ticketId ? '?ticketId=' + encodeURIComponent(ticketId) : ''));
    },
    matchmakingLeave(ticketId) {
      return this.api(this.gamePath('/matchmaking'), { method: 'DELETE', body: JSON.stringify({ ticketId: ticketId || undefined }) });
    },
    async createAiSession(config) {
      const res = await this.api(this.gamePath('/sessions/ai'), { method: 'POST', body: JSON.stringify(config || {}) });
      return res && res.sessionId ? res.sessionId : null;
    },
    openGameSocket(sessionId, handlers) {
      const proto = root.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({ sessionId });
      if (this._token) qs.set('access_token', this._token);
      const ws = new WebSocket(proto + '//' + root.location.host + '/ws/v1/games?' + qs.toString());
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // Sync-on-open: adopt the authoritative snapshot before playing.
        try { ws.send(JSON.stringify({ type: 'sync' })); } catch (e) { /* ok */ }
        if (handlers && handlers.onOpen) handlers.onOpen(ws);
      };
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data)); }
        catch (e) { return; }
        if (handlers && handlers.onMessage) handlers.onMessage(msg);
      };
      ws.onclose = (ev) => { if (handlers && handlers.onClose) handlers.onClose(ev); };
      ws.onerror = () => {};
      return ws;
    },
    // The script's command envelope, ready to send over the game socket.
    cmdMessage(playerId, commandId, cmd) {
      return JSON.stringify({ type: 'cmd', data: { playerId, commandId, cmd } });
    },

    /* Server time (hosted only; offline keeps the local clock and never
     * probes — a speculative 404 logs a console error on static servers). */
    async syncTime() {
      if (!this.present) return;
      try {
        const t0 = Date.now();
        const res = await fetch('/api/v1/time', { headers: this._headers() });
        if (!res.ok) return;
        const body = await res.json();
        const t1 = Date.now();
        const serverMs = Number(body.now ?? body.serverTime ?? body.epochMs);
        if (Number.isFinite(serverMs)) this._timeOffset = serverMs - (t0 + (t1 - t0) / 2);
      } catch (e) { /* local clock */ }
    },
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
