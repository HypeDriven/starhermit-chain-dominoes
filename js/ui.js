/* Chain Dominoes — UI layer. Responsive DOM shell, focus management,
 * accessibility mirror of the board, keyboard/gamepad input, overlays,
 * settings, profile, help. The canvas is never the only UI: every game
 * action is available through the semantic controls in this module.
 */
(function (root) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const R = () => root.ChainDominoesRules;
  const C = () => root.ChainDominoesContent;
  const P = () => root.ChainDominoesPlatform;

  /* ------------------------------------------------------------ helpers */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const PIP_CELLS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  function halfEl(value) {
    const half = el('span', 'half');
    for (let i = 0; i < 9; i++) {
      half.appendChild(el('span', 'pipdot' + (PIP_CELLS[value].includes(i) ? '' : ' empty')));
    }
    return half;
  }

  // A domino as a semantic button (or static chip for the chain strip).
  function dominoEl(a, b, opts) {
    opts = opts || {};
    const d = document.createElement(opts.static ? 'div' : 'button');
    d.className = 'domino' + (opts.flat ? ' flat' : '') + (opts.back ? ' back' : '');
    d.setAttribute('role', opts.static ? 'img' : 'option');
    const label = opts.back ? 'face-down tile' : (a + ' | ' + b + ' domino');
    d.setAttribute('aria-label', label + (opts.extraLabel ? ', ' + opts.extraLabel : ''));
    if (!opts.back) {
      d.appendChild(halfEl(a));
      d.appendChild(halfEl(b));
      if (opts.numbers) {
        d.appendChild(el('span', 'pipnum top', String(a)));
        d.appendChild(el('span', 'pipnum bottom', String(b)));
      }
    }
    return d;
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ============================================================ UI class */
  class UI {
    constructor(deps) {
      this.store = deps.store;
      this.audio = deps.audio;
      this.sessionFactory = deps.sessionFactory;
      this.game = null;              // active Session
      this.renderer = null;
      this.screen = 'title';
      this._navFrom = 'title';
      this._lastFocus = null;
      this._pendingSetup = null;     // {mode, content, config}
      this._actionSeq = 0;
      this._gamepad = { idx: null, prev: {}, focus: 0 };
      this._hbTimer = null;
      this._captionTimer = null;
      this._bound = false;
      this._resultsRetryOverride = null;
    }

    init() {
      this._applySettingsClasses();
      this._buildThemeOptions();
      this._bindStatic();
      this._buildHelp();
      this._bindKeyboard();
      this._bindGamepad();
      this._bindLifecycle();
      this.refreshTitle();
      this.showScreen('title');
      this._syncSettingsForm();
    }

    /* ------------------------------------------------------- navigation */
    showScreen(name) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const scr = $('screen-' + name);
      if (scr) scr.classList.add('active');
      this.screen = name;
      const focusable = scr && scr.querySelector('button, [tabindex], input, select');
      if (focusable) setTimeout(() => focusable.focus(), 30);
    }

    _nav(name) {
      this._navFrom = this.screen;
      if (name === 'journey') this._buildJourneyList();
      if (name === 'learn') this._buildTutorialList();
      if (name === 'profile') this._buildProfile();
      if (name === 'settings') this._syncSettingsForm();
      this.showScreen(name);
    }

    _bindStatic() {
      const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
      on('btn-quick-play', () => this._quickPlay());
      on('btn-continue', () => this._continueSaved());
      on('btn-daily', () => this._setupDaily());
      on('btn-journey', () => this._nav('journey'));
      on('btn-practice', () => this._setupPractice());
      on('btn-challenge', () => this._setupChallengeList());
      on('btn-learn', () => this._nav('learn'));
      on('btn-hosted', () => this._setupHosted());
      on('btn-profile', () => this._nav('profile'));
      on('btn-settings', () => this._nav('settings'));
      on('btn-help', () => this._nav('help'));
      document.querySelectorAll('[data-nav]').forEach(b =>
        b.addEventListener('click', () => this._nav(b.dataset.nav)));

      // game controls
      on('btn-pause', () => this.pauseGame());
      on('btn-resume', () => this.resumeGame());
      on('btn-leave-match', () => this.leaveMatch());
      on('btn-pause-settings', () => { this._closeOverlay('overlay-pause'); this._nav('settings'); });
      on('btn-pause-help', () => { this._closeOverlay('overlay-pause'); this._nav('help'); });
      on('btn-next-round', () => { this._closeOverlay('overlay-round'); if (this.game) this.game.continueNextRound(); this.audio.roundIntro(); });
      // The results screen is reused by lessons, which need a different
      // "again" action. Dispatch through an override instead of replacing the
      // button — a replaced node loses this listener for every later match.
      on('btn-results-retry', () => {
        const override = this._resultsRetryOverride;
        if (override) { this._resultsRetryOverride = null; override(); return; }
        this._retry();
      });
      on('btn-results-next', () => this._nextStage());
      on('btn-results-menu', () => { this._closeOverlay('overlay-results'); this._toTitle(); });
      on('btn-draw', () => this._doAction({ type: 'draw' }));
      on('btn-pass', () => this._doAction({ type: 'pass' }));
      on('btn-hint', () => { if (this.game) this.game.hint(); });
      on('btn-undo', () => { if (this.game) this.game.undo(); });
      on('btn-skip', () => { if (this.game) this.game.skipToSettled(); });
      on('btn-view', () => {
        if (!this.renderer) return;
        const top = this.renderer.toggleTopDown();
        const b = document.getElementById('btn-view');
        if (b) b.setAttribute('aria-pressed', top ? 'true' : 'false');
      });
      on('btn-tutorial-quit', () => this.leaveMatch());
      on('btn-end-left', () => this._commitToEnd('left'));
      on('btn-end-right', () => this._commitToEnd('right'));
      on('btn-save-name', () => this._saveName());
      on('btn-keep-local', () => { this.store.resolveConflict('local'); this._buildProfile(); });
      on('btn-keep-remote', () => { this.store.resolveConflict('remote'); this._buildProfile(); });
      on('btn-replay-tutorials', () => {
        this.store.progress.tutorials = [];
        this.store.saveNow();
        this._nav('learn');
      });
      on('btn-reset-save', () => this._resetSave());

      // settings inputs
      const S = () => this.store.settings;
      const bind = (id, key, apply) => {
        const input = $(id);
        if (!input) return;
        input.addEventListener('change', () => {
          const v = input.type === 'checkbox' ? input.checked : input.value;
          apply(v);
          if (input.type === 'checkbox') this.audio.toggle();
          this.store.saveNow();
          P().telemetry.event('settings-change', { key });
          this._applySettingsClasses();
        });
      };
      bind('set-muted', 'muted', v => { S().muted = v; this.audio.setMuted(v); });
      bind('vol-music', 'music', v => { S().volumes.music = +v; this.audio.setVolume('music', +v); });
      bind('vol-effects', 'effects', v => { S().volumes.effects = +v; this.audio.setVolume('effects', +v); });
      bind('vol-ambience', 'ambience', v => { S().volumes.ambience = +v; this.audio.setVolume('ambience', +v); });
      bind('vol-voice', 'voice', v => { S().volumes.voice = +v; this.audio.setVolume('voice', +v); });
      bind('set-quality', 'quality', v => { S().quality = v; this._applyQuality(); });
      bind('set-theme', 'theme', v => { S().theme = v; this._applyTheme(); });
      bind('set-numbers', 'showNumbers', v => { S().showNumbers = v; this._refreshView(); });
      bind('set-motion', 'reducedMotion', v => { S().reducedMotion = v; if (this.renderer) this.renderer.setReducedMotion(v); });
      bind('set-contrast', 'highContrast', v => { S().highContrast = v; });
      bind('set-largetext', 'largeText', v => { S().largeText = v; });
      bind('set-lefthand', 'leftHanded', v => { S().leftHanded = v; });
      bind('set-cvd', 'colorVision', v => { S().colorVision = v; });
      bind('set-timing', 'timingAssist', v => { S().timingAssist = v; });
      bind('set-haptics', 'haptics', v => { S().haptics = v; });
      bind('set-hold', 'holdToConfirm', v => { S().holdToConfirm = v; });
      bind('set-hints', 'hints', v => { S().hints = v; });
      bind('set-undo', 'undo', v => { S().undo = v; });
      bind('set-telemetry', 'telemetry', v => P().telemetry.setConsent(v));

      // volume sliders: drag sound while sliding (throttled)
      ['vol-music', 'vol-effects', 'vol-ambience', 'vol-voice'].forEach(id => {
        const s = $(id);
        if (!s) return;
        let lastDrag = 0;
        s.addEventListener('input', () => {
          const n = Date.now();
          if (n - lastDrag > 120) { lastDrag = n; this.audio.sliderDrag(); }
        });
      });

      // audio unlock on first gesture + captions wiring
      const unlockAudio = () => {
        if (this.audio.init()) {
          this.audio.resume();
          this._applyVolumes();
          if (this.screen === 'game') this.audio.startAll();
        }
      };
      window.addEventListener('pointerdown', unlockAudio, { once: false });
      window.addEventListener('keydown', unlockAudio, { once: false });
      this.audio.onCaption = (text) => this._showCaption(text);

      // leaderboard tabs
      document.querySelectorAll('.lb-tab').forEach(t =>
        t.addEventListener('click', () => {
          document.querySelectorAll('.lb-tab').forEach(x => x.classList.remove('active'));
          t.classList.add('active');
          this.audio.tabSwitch();
          this._buildLeaderboard(t.dataset.lb);
        }));

      // hover tick on interactive elements
      document.addEventListener('pointerover', (e) => {
        if (e.target.closest && e.target.closest('button, .lb-tab, [data-nav], input, select')) this.audio.hover();
      });
    }

    /* ---------------------------------------------------------- settings */
    _buildThemeOptions() {
      const sel = $('set-theme');
      sel.innerHTML = '';
      C().THEMES.forEach(t => sel.appendChild(el('option', '', t.name)).value = t.id);
      sel.childNodes.forEach((o, i) => o.value = C().THEMES[i].id);
    }

    _syncSettingsForm() {
      const s = this.store.settings;
      const set = (id, v) => { const i = $(id); if (i) { if (i.type === 'checkbox') i.checked = !!v; else i.value = v; } };
      set('set-muted', s.muted); set('vol-music', s.volumes.music); set('vol-effects', s.volumes.effects);
      set('vol-ambience', s.volumes.ambience); set('vol-voice', s.volumes.voice);
      set('set-quality', s.quality); set('set-theme', s.theme); set('set-numbers', s.showNumbers);
      set('set-motion', s.reducedMotion); set('set-contrast', s.highContrast); set('set-largetext', s.largeText);
      set('set-lefthand', s.leftHanded); set('set-cvd', s.colorVision); set('set-timing', s.timingAssist);
      set('set-haptics', s.haptics); set('set-hold', s.holdToConfirm);
      set('set-hints', s.hints); set('set-undo', s.undo);
      set('set-telemetry', P().telemetry.consent);
      const bl = $('bindings-list');
      bl.innerHTML = '';
      const names = {
        navLeft: 'Navigate left', navRight: 'Navigate right', navUp: 'Navigate up', navDown: 'Navigate down',
        confirm: 'Confirm', cancel: 'Cancel', pause: 'Pause', undo: 'Undo', hint: 'Hint',
        cameraReset: 'Reset camera', endLeft: 'Play on left end', endRight: 'Play on right end',
        draw: 'Draw', pass: 'Pass',
      };
      Object.keys(names).forEach(k => {
        bl.appendChild(el('dt', '', names[k]));
        bl.appendChild(el('dd', '', s.bindings[k] || '—'));
      });
    }

    _applyVolumes() {
      const v = this.store.settings.volumes;
      ['music', 'effects', 'ambience', 'voice'].forEach(b => this.audio.setVolume(b, v[b]));
      this.audio.setMuted(this.store.settings.muted);
    }

    _applyQuality() {
      if (!this.renderer) return;
      this.renderer.setQuality(this._qualityTier());
    }

    _qualityTier() {
      const q = this.store.settings.quality;
      if (q !== 'auto') return q;
      // mechanism-backed auto tier: mobile UA or few cores -> low/medium
      const mobile = /Mobi|Android/i.test(navigator.userAgent);
      const cores = navigator.hardwareConcurrency || 4;
      if (mobile && cores <= 4) return 'low';
      if (mobile) return 'medium';
      return cores >= 8 ? 'high' : 'medium';
    }

    _applyTheme() {
      const t = C().themeById(this.store.settings.theme);
      const css = t.css;
      const rs = document.documentElement.style;
      rs.setProperty('--bg', css.bg); rs.setProperty('--panel', css.panel);
      rs.setProperty('--panel-2', 'color-mix(in srgb, ' + css.panel + ' 80%, white 8%)');
      rs.setProperty('--text', css.text); rs.setProperty('--accent', css.accent);
      rs.setProperty('--good', css.good); rs.setProperty('--bad', css.bad);
      rs.setProperty('--tile-body', '#' + t.tileBody.toString(16).padStart(6, '0'));
      rs.setProperty('--tile-pip', '#' + t.pip.toString(16).padStart(6, '0'));
    }

    _applySettingsClasses() {
      const s = this.store.settings, b = document.body;
      b.classList.toggle('reduced-motion', !!s.reducedMotion);
      b.classList.toggle('large-text', !!s.largeText);
      b.classList.toggle('high-contrast', !!s.highContrast);
      b.classList.toggle('left-handed', !!s.leftHanded);
      ['protanopia', 'deuteranopia', 'tritanopia'].forEach(k =>
        b.classList.toggle('cvd-' + k, s.colorVision === k));
      this._applyTheme();
    }

    _resetSave() {
      if (!confirm('Erase all local progress? This cannot be undone.')) return;
      try { localStorage.removeItem('chaindominoes.save.v1'); } catch (e) { /* ok */ }
      location.reload();
    }

    /* ------------------------------------------------------------ title */
    refreshTitle() {
      const jp = this.store.progress.journey;
      const won = Object.values(jp).filter(v => v.stars > 0).length;
      $('journey-progress-label').textContent = won + '/40';
      $('learn-progress-label').textContent = this.store.progress.tutorials.length + '/6';
      const daily = C().dailyForDate(new Date(P().host.now()));
      $('daily-badge').classList.toggle('hidden', !this.store.progress.daily[daily.dateKey]);
      const hasSave = !!this.store.doc.savedMatch;
      $('btn-continue').classList.toggle('hidden', !hasSave);
      // Always reachable: offline this screen still offers pass-and-play,
      // which was otherwise unreachable because the entry was hidden.
      const hosted = $('btn-hosted');
      hosted.classList.remove('hidden');
      hosted.textContent = P().host.present ? 'Hosted Play' : 'Pass & Play';
      $('host-status').textContent = P().host.present
        ? 'Connected to StarHermit · cloud saves on'
        : 'Offline mode · progress stays on this device';
    }

    _quickPlay() {
      // Shortest path: next unbeaten journey stage, else practice.
      const next = C().JOURNEY.find(s => !(this.store.progress.journey[s.id] || {}).stars);
      if (next && !this.store.progress.tutorials.length) {
        this._startTutorial(C().TUTORIALS[0]);
      } else if (next) {
        this._startJourneyStage(next);
      } else {
        this._setupPractice();
      }
    }

    /* -------------------------------------------------------- setup flow */
    _fact(k, v) {
      const d = el('div', 'fact');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v', v));
      return d;
    }

    _showSetup(title, facts, content, config, mode, extraHtml) {
      $('setup-heading').textContent = title;
      const body = $('setup-body');
      body.innerHTML = '';
      const panel = el('section', 'panel');
      panel.appendChild(el('h3', '', 'This table'));
      const grid = el('div', 'fact-grid');
      facts.forEach(([k, v]) => grid.appendChild(this._fact(k, v)));
      panel.appendChild(grid);
      if (extraHtml) panel.appendChild(extraHtml);
      const start = el('button', 'btn btn-primary btn-big', 'Take a seat');
      start.id = 'btn-take-seat';
      start.addEventListener('click', () => this._startMatch(mode, content, config));
      panel.appendChild(start);
      body.appendChild(panel);
      this._navFrom = 'title';
      this.showScreen('setup');
      setTimeout(() => start.focus(), 60);
    }

    _rulesetFacts(ruleset, players, ranked) {
      const drawLabel = { 'until-playable': 'Draw until playable', one: 'One draw per turn', none: 'Boneyard closed' }[ruleset.drawRule || 'until-playable'];
      return [
        ['Players', String(players)],
        ['Target', ruleset.targetScore > 0 ? ruleset.targetScore + ' pts' : 'Highest score'],
        ['Rounds max', String(ruleset.maxRounds || 12)],
        ['Drawing', drawLabel],
        ['Ranked', ranked ? 'Yes' : 'No'],
        ['~Duration', '5–15 min'],
      ];
    }

    _setupPractice() {
      const form = el('div');
      const mk = (labelText, input) => {
        const l = el('label', 'field', labelText);
        l.appendChild(input);
        form.appendChild(l);
        return input;
      };
      const selPlayers = el('select');
      [2, 3, 4].forEach(n => selPlayers.appendChild(el('option', '', n + ' players')).value = n);
      const selDiff = el('select');
      ['easy', 'medium', 'hard'].forEach(d => selDiff.appendChild(el('option', '', d)).value = d);
      selDiff.value = 'medium';
      const selTarget = el('select');
      [50, 100, 150].forEach(t => selTarget.appendChild(el('option', '', t + ' points')).value = t);
      const selDraw = el('select');
      [['until-playable', 'Draw until playable'], ['one', 'One draw per turn'], ['none', 'Boneyard closed']]
        .forEach(([v, l]) => selDraw.appendChild(el('option', '', l)).value = v);
      mk('Players', selPlayers); mk('Difficulty', selDiff); mk('Target score', selTarget); mk('Draw rule', selDraw);
      const note = el('p', 'muted', 'Practice is unranked: undo and hints are on, ratings are untouched.');
      form.appendChild(note);

      this._showSetup('Practice', [['Players', '2'], ['Target', '100 pts'], ['Ranked', 'No']], null, null, 'practice', form);
      // rewire start to read the form
      const panel = $('setup-body').querySelector('.panel');
      const start = panel.querySelector('.btn-primary');
      const facts = panel.querySelector('.fact-grid');
      const update = () => {
        facts.innerHTML = '';
        this._rulesetFacts({ targetScore: +selTarget.value, drawRule: selDraw.value }, +selPlayers.value, false)
          .forEach(([k, v]) => facts.appendChild(this._fact(k, v)));
      };
      [selPlayers, selDiff, selTarget, selDraw].forEach(s => s.addEventListener('change', update));
      update();
      const newStart = start.cloneNode(true); // deep: a shallow clone drops the label text
      start.replaceWith(newStart);
      newStart.addEventListener('click', () => {
        const cfg = C().practiceConfig({
          players: +selPlayers.value, difficulty: selDiff.value,
          targetScore: +selTarget.value, drawRule: selDraw.value,
        }, this.store.profile.name);
        this._startMatch('practice', { id: 'practice', name: 'Practice' }, cfg);
      });
    }

    _setupDaily() {
      const daily = C().dailyForDate(new Date(P().host.now()));
      const cfg = C().dailyToConfig(daily, this.store.profile.name);
      const done = this.store.progress.daily[daily.dateKey];
      const info = el('div');
      info.appendChild(el('p', '', daily.goal));
      info.appendChild(el('p', 'muted', 'One shared seed for everyone today (UTC). Ranked: undo and hints are off.' +
        (done ? ' You already played today — replaying is for fun and won\'t replace your result.' : '')));
      this._showSetup(daily.name, this._rulesetFacts(daily.ruleset, daily.players, true), daily, cfg, 'daily', info);
    }

    _setupChallengeList() {
      const body = $('setup-body');
      $('setup-heading').textContent = 'Challenges';
      body.innerHTML = '';
      C().CHALLENGES.forEach(ch => {
        const panel = el('section', 'panel');
        panel.appendChild(el('h3', '', ch.name));
        panel.appendChild(el('p', '', ch.goal));
        const grid = el('div', 'fact-grid');
        this._rulesetFacts(ch.ruleset, ch.players, true).forEach(([k, v]) => grid.appendChild(this._fact(k, v)));
        if (ch.timeLimitSec) grid.appendChild(this._fact('Time limit', fmtTime(ch.timeLimitSec * 1000)));
        panel.appendChild(grid);
        const start = el('button', 'btn btn-primary', 'Start challenge');
        start.addEventListener('click', () => {
          const cfg = C().challengeToConfig(ch, this.store.profile.name);
          this._startMatch('challenge', ch, cfg);
        });
        panel.appendChild(start);
        body.appendChild(panel);
      });
      this.showScreen('setup');
    }

    _setupHosted() {
      const body = $('setup-body');
      $('setup-heading').textContent = P().host.present ? 'Hosted Play' : 'Pass & Play';
      body.innerHTML = '';
      const panel = el('section', 'panel');
      panel.appendChild(el('h3', '', 'Play with friends'));
      panel.appendChild(el('p', '', P().host.present
        ? 'Create a private invitation or join public matchmaking. Hosted sessions are authoritative: the server validates every move.'
        : 'Hosted play needs the StarHermit shell. Offline, you can still pass-and-play or face the AI.'));
      const mk = (label, fn, id) => {
        const b = el('button', 'btn', label);
        if (id) b.id = id;
        b.addEventListener('click', fn);
        panel.appendChild(b);
      };
      if (P().host.present) {
        mk('Create private invitation', () => this._hostedCreate());
        mk('Find public match', () => this._hostedMatchmake());
      }
      mk('Pass-and-play (2 humans, this device)', () => {
        const cfg = { seed: 'hotseat:' + Date.now(), ruleset: { targetScore: 100 }, players: [
          { id: 'p1', name: 'Player 1', kind: 'human' }, { id: 'p2', name: 'Player 2', kind: 'human' }] };
        this._startMatch('practice', { id: 'hotseat', name: 'Pass and Play' }, cfg);
      }, 'btn-hotseat');
      body.appendChild(panel);
      this.showScreen('setup');
    }

    async _hostedCreate() {
      // Private table via the platform matchmaking queue (real games API).
      try {
        const res = await P().host.matchmakingJoin({ private: true, ruleset: { targetScore: 100 } });
        const panel = $('setup-body').querySelector('.panel');
        const code = res.inviteCode || res.ticketId || res.sessionId;
        panel.appendChild(el('p', '', 'Invitation queued' + (code ? ': ' + code : '') +
          '. Hosted tables open when the realtime play update ships — pass-and-play and AI tables are fully playable now.'));
        this._announce('Invitation created.');
      } catch (e) {
        this._announce('Could not create invitation: ' + e.message, 'error');
      }
    }
    async _hostedMatchmake() {
      // Public matchmaking through the real queue: join, poll for a match,
      // and leave the queue afterwards. Table play itself needs the realtime
      // client, which this build does not ship — the UI says so honestly.
      try {
        const joined = await P().host.matchmakingJoin({ ruleset: { targetScore: 100 } });
        const ticketId = joined.ticketId || joined.id || null;
        this._announce('Searching for a match…');
        const poll = async () => {
          let status = null;
          try { status = await P().host.matchmakingPoll(ticketId); } catch (e) { return; }
          if (status && (status.matched || status.sessionId)) {
            this._announce('Match found.');
            this._toast('Match found — hosted tables need the realtime play update; AI and pass-and-play tables are fully playable.');
            try { await P().host.matchmakingLeave(ticketId); } catch (e) { /* ok */ }
          } else if (status && status.error) {
            this._announce('Matchmaking: ' + status.error, 'error');
          } else {
            this._matchPollTimer = setTimeout(poll, 3000);
          }
        };
        this._matchPollTimer = setTimeout(poll, 1500);
      } catch (e) {
        this._announce('Matchmaking unavailable: ' + e.message, 'error');
      }
    }

    /* ----------------------------------------------------- learn/journey */
    _buildTutorialList() {
      const list = $('tutorial-list');
      list.innerHTML = '';
      C().TUTORIALS.forEach((t, i) => {
        const li = el('li');
        const done = this.store.progress.tutorials.includes(t.id);
        const box = el('div');
        box.appendChild(el('div', 'card-title', (i + 1) + '. ' + t.title));
        box.appendChild(el('div', 'card-desc', t.intro));
        li.appendChild(box);
        const go = el('button', 'btn btn-primary card-go', done ? 'Replay' : 'Start');
        go.addEventListener('click', () => this._startTutorial(t));
        li.appendChild(go);
        if (done) li.appendChild(el('span', 'card-done', '✓'));
        list.appendChild(li);
      });
    }

    _buildJourneyList() {
      const list = $('journey-list');
      list.innerHTML = '';
      let unlocked = true; // first stage always open; a stage opens when the previous is won
      let totalStars = 0;
      C().JOURNEY.forEach(s => {
        const rec = this.store.progress.journey[s.id];
        const stars = rec ? rec.stars : 0;
        totalStars += stars;
        const li = el('li', 'journey-item' + (unlocked ? '' : ' locked') + (s.mastery ? ' mastery' : ''));
        li.appendChild(el('span', 'journey-num', s.mastery ? '★' : String(s.number)));
        const box = el('div');
        box.appendChild(el('div', 'journey-name', s.name));
        box.appendChild(el('div', 'journey-meta',
          s.players + 'P · ' + (s.ai.join('/')) + ' AI · first to ' + s.targetScore +
          (s.drawRule === 'none' ? ' · no draws' : s.drawRule === 'one' ? ' · 1 draw/turn' : '') +
          (s.maxRounds ? ' · ≤' + s.maxRounds + ' rounds' : '')));
        li.appendChild(box);
        const starTxt = '★'.repeat(stars) + '☆'.repeat(3 - stars);
        li.appendChild(el('span', 'journey-stars', unlocked ? starTxt : '🔒'));
        if (unlocked) {
          li.style.cursor = 'pointer';
          li.tabIndex = 0;
          const open = () => this._startJourneyStage(s);
          li.addEventListener('click', open);
          li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        }
        list.appendChild(li);
        unlocked = unlocked && stars > 0;
      });
      $('journey-stars-total').textContent = '★ ' + totalStars + ' / 120';
    }

    /* --------------------------------------------------------- start game */
    _startTutorial(t) {
      const cfg = t.setup;
      this._startMatch('tutorial', t, {
        seed: t.id, ruleset: t.setup.ruleset, players: t.setup.players.map(p => Object.assign({}, p)),
        custom: t.setup,
      });
    }

    _startJourneyStage(s) {
      const cfg = C().stageToConfig(s, this.store.profile.name);
      this._startMatch('journey', s, cfg);
    }

    _startMatch(mode, content, config) {
      this._closeAllOverlays();
      if (this.game) this.game.leave();
      const Session = root.ChainDominoesSession.Session;
      this.game = new Session({ store: this.store, audio: this.audio });
      this._wireSession(this.game);
      this._attachRenderer();
      const options = {
        undo: this.store.settings.undo && (mode === 'practice' || mode === 'journey' || mode === 'tutorial'),
        hints: this.store.settings.hints && mode !== 'daily' && mode !== 'challenge',
        ranked: mode === 'daily' || mode === 'challenge',
        timeLimitSec: content && content.timeLimitSec ? content.timeLimitSec : 0,
      };
      this.game.startMatch(mode, content, config, options);
      this.showScreen('game');
      if (this.renderer) this.renderer.resize();
      this._buildGameChrome(mode, content, config);
      $('hud-clock').classList.toggle('hidden', !(options.timeLimitSec > 0));
      this.audio.init(); this.audio.resume(); this._applyVolumes(); this.audio.startAll();
      this.audio.confirm();
      this.audio.roundIntro();
      this._timerWarned = false;
      this._refreshView();
    }

    _wireSession(game) {
      game.onView = (view) => this._renderView(view);
      game.onAnnounce = (text, kind) => this._announce(text, kind);
      game.onEvent = (name, payload) => this._onSessionEvent(name, payload);
    }

    _attachRenderer() {
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      const canvas = $('glcanvas');
      try {
        if (!root.THREE) throw new Error('three.js not loaded');
        this.renderer = new root.ChainDominoesRender.ChainRenderer(canvas, {
          theme: C().themeById(this.store.settings.theme),
          quality: this._qualityTier(),
          reducedMotion: this.store.settings.reducedMotion,
        });
        this.renderer.onPick = (info) => this._onPick(info);
        $('webgl-fallback').classList.add('hidden');
        if (this.game) this.game.renderer = this.renderer;
      } catch (e) {
        this.renderer = null;
        $('webgl-fallback').classList.remove('hidden');
      }
    }

    _buildGameChrome(mode, content, config) {
      const obj = $('hud-objective');
      const target = config.ruleset.targetScore;
      obj.textContent = mode === 'tutorial' ? ('Lesson: ' + content.title)
        : (content && (content.goal || content.blurb)) ||
          ('First to ' + (target > 0 ? target : 'best score') + (config.ruleset.drawRule === 'none' ? ' · boneyard closed' : ''));
      obj.setAttribute('aria-label', 'Objective. ' + obj.textContent);
      $('rail-ruleset').innerHTML = '';
      const rl = $('rail-ruleset');
      const drawLabel = { 'until-playable': 'Draw until you can play', one: 'One draw per turn', none: 'No drawing' }[config.ruleset.drawRule || 'until-playable'];
      rl.appendChild(el('div', 'muted', drawLabel + ' · max ' + (config.ruleset.maxRounds || 12) + ' rounds'));
      const banner = $('tutorial-banner');
      banner.classList.toggle('hidden', mode !== 'tutorial');
      // drawer toggle for compact layouts
      if (!$('toggle-rail-left')) {
        const t = el('button', 'btn btn-ghost drawer-toggle', '☰ Table');
        t.id = 'toggle-rail-left';
        t.setAttribute('aria-label', 'Toggle table panel');
        t.addEventListener('click', () => $('rail-left').classList.toggle('open'));
        $('screen-game').appendChild(t);
      }
    }

    /* ------------------------------------------------------- input → act */
    _nextActionId() { return 'a' + (++this._actionSeq) + '-' + Date.now(); }

    _doAction(cmd) {
      if (!this.game) return;
      this.audio.ack();
      const res = this.game.act(cmd, this._nextActionId());
      if (res && res.ok === false && res.reason) this._haptic([30, 40, 30]);
    }

    _commitToEnd(end) {
      if (!this.game || this.game.selectedTile === null) return;
      this._doAction({ type: 'play', tileId: this.game.selectedTile, end });
    }

    _onPick(info) {
      if (!this.game || this.game.paused) return;
      if (info.kind === 'tile') {
        const id = +info.tileId;
        const view = this.game.buildView();
        if (this.game.selectedTile === id) {
          // second tap on selected tile: commit if exactly one legal end
          const ends = view && view.legalEnds;
          if (ends && ends.length === 1) this._doAction({ type: 'play', tileId: id, end: ends[0] });
          else this.game.selectTile(id);
        } else {
          this.audio.ack();
          this.game.selectTile(id);
          this._haptic(15);
        }
      } else if (info.kind === 'end') {
        this._commitToEnd(info.end);
      } else if (info.kind === 'table') {
        if (this.game) { this.game.selectedTile = null; this.game._emitView(); }
      }
    }

    _haptic(pattern) {
      if (this.store.settings.haptics && navigator.vibrate) {
        try { navigator.vibrate(pattern); } catch (e) { /* ok */ }
      }
    }

    /* ------------------------------------------------------- view render */
    _refreshView() { if (this.game) this.game._emitView(); }

    _renderView(view) {
      if (!view) return;
      // scores
      const sc = $('hud-scores');
      sc.innerHTML = '';
      view.players.forEach(p => {
        const chip = el('span', 'score-chip' + (p.isTurn ? ' turn' : ''),
          p.name + ' ' + p.score + ' ');
        chip.appendChild(el('span', 'pip', '(' + p.handCount + ')'));
        sc.appendChild(chip);
      });
      // rails
      const ro = $('rail-objective');
      ro.innerHTML = '';
      if (view.leftEnd !== null) {
        const ends = el('div', 'big-ends');
        ends.appendChild(el('span', '', String(view.leftEnd)));
        ends.appendChild(el('span', '', String(view.rightEnd)));
        ro.appendChild(el('div', 'muted', 'Open ends'));
        ro.appendChild(ends);
      } else {
        ro.appendChild(el('div', 'muted', 'No tiles on the table yet.'));
      }
      $('rail-round').textContent = 'Round ' + view.round +
        (view.targetScore > 0 ? ' · target ' + view.targetScore : ' · single match to best score');
      $('rail-boneyard').textContent = 'Boneyard: ' + view.boneyardCount + ' tile' + (view.boneyardCount === 1 ? '' : 's');
      const ti = $('turn-indicator');
      ti.textContent = view.phase === 'active'
        ? ((view.myTurn && !view.hotseat) ? 'Your turn' : view.turnName + '’s turn')
        : 'Round over';
      ti.classList.toggle('your-turn', !!view.myTurn);

      // action buttons
      $('btn-draw').classList.toggle('hidden', !view.canDraw);
      $('btn-pass').classList.toggle('hidden', !view.canPass);
      $('btn-draw').disabled = !view.myTurn;
      $('btn-pass').disabled = !view.myTurn;
      $('btn-hint').classList.toggle('hidden', !(this.game && this.game.options.hints));
      $('btn-hint').disabled = !view.myTurn;
      $('btn-undo').classList.toggle('hidden', !(this.game && this.game.options.undo));
      $('btn-undo').disabled = !(this.game && this.game.canUndo());

      // chain strip (DOM mirror)
      const strip = $('chain-strip');
      strip.innerHTML = '';
      view.chain.forEach(c => {
        const li = el('li');
        const d = dominoEl(c.a, c.b, { flat: true, static: true, numbers: this.store.settings.showNumbers });
        d.setAttribute('aria-label', c.a + '|' + c.b + (c.double ? ' double' : '') + ' on the table');
        li.appendChild(d);
        strip.appendChild(li);
      });

      // end caps
      const sel = view.selectedTile;
      const showEnds = view.myTurn && sel !== null && view.legalEnds.length > 0;
      for (const end of ['left', 'right']) {
        const btn = $('btn-end-' + end);
        const val = end === 'left' ? view.leftEnd : view.rightEnd;
        const legal = showEnds && view.legalEnds.includes(end);
        btn.classList.toggle('hidden', !legal);
        if (legal) {
          btn.textContent = val === null ? '●' : String(val);
          btn.setAttribute('aria-label', 'Play selected tile on ' + end + ' end (' + (val === null ? 'open table' : val) + ')');
        }
      }

      // hand
      const hand = $('hand-list');
      hand.innerHTML = '';
      view.myHand.forEach(id => {
        const [a, b] = view.tileFaces[id];
        const li = el('li');
        li.setAttribute('role', 'presentation'); // keep listbox → option direct
        const playable = !!view.playableTiles[id];
        const d = dominoEl(a, b, {
          numbers: this.store.settings.showNumbers,
          extraLabel: playable ? 'playable' : 'not playable now',
        });
        d.classList.toggle('selected', sel === id);
        d.classList.toggle('unplayable', view.myTurn && !playable);
        d.setAttribute('aria-selected', sel === id ? 'true' : 'false');
        if (view.tutorial && view.tutorial.highlight && view.tutorial.highlight.tileId === id) d.classList.add('highlight');
        d.disabled = !view.myTurn;
        d.addEventListener('click', () => this._onPick({ kind: 'tile', tileId: String(id) }));
        li.appendChild(d);
        hand.appendChild(li);
      });
      const handOwner = view.hotseat ? view.myName + '’s hand' : 'Your hand';
      $('hand-label').textContent = handOwner + ' (' + view.myHand.length + ')';
      $('hand-list').setAttribute('aria-label', handOwner);
      $('hand-tray').setAttribute('aria-label', handOwner);

      // tutorial banner
      if (view.tutorial) {
        $('tutorial-text').textContent = view.tutorial.text;
        $('tutorial-step-count').textContent = 'Step ' + (view.tutorial.index + 1) + ' of ' + view.tutorial.total;
        $('tutorial-banner').classList.remove('hidden');
      } else if (this.game && this.game.mode !== 'tutorial') {
        $('tutorial-banner').classList.add('hidden');
      }
    }

    _onSessionEvent(name, payload) {
      if (name === 'round-end') this._showRoundOverlay(payload);
      else if (name === 'results') this._showResults(payload);
      else if (name === 'invalid') { this._haptic([40, 60, 40]); }
      else if (name === 'achievement') { this.audio.success(); this._toast('Achievement: ' + payload.name + ' — ' + payload.desc); }
      else if (name === 'tutorial-complete') this._showTutorialComplete(payload);
      else if (name === 'tutorial') { /* banner handled in view */ }
      else if (name === 'hint') {
        if (payload.type === 'play') {
          const hand = $('hand-list');
          const idx = this.game.buildView().myHand.indexOf(payload.tileId);
          const tile = hand.children[idx] && hand.children[idx].querySelector('.domino');
          if (tile) { tile.classList.add('highlight'); setTimeout(() => tile.classList.remove('highlight'), 2200); }
        }
      } else if (name === 'clock') {
        $('hud-clock').textContent = fmtTime(payload.remainingMs);
        if (payload.remainingMs <= 10000) {
          if (!this._timerWarned) { this._timerWarned = true; this.audio.timerWarning(); }
          const sec = Math.ceil(payload.remainingMs / 1000);
          if (payload.remainingMs <= 5000 && sec !== this._lastCountdownSec) {
            this._lastCountdownSec = sec;
            this.audio.countdownTick();
          }
        } else { this._timerWarned = false; this._lastCountdownSec = 0; }
      }
    }

    /* --------------------------------------------------------- overlays */
    _openOverlay(id) {
      this._lastFocus = document.activeElement;
      $(id).classList.remove('hidden');
      if (id !== 'overlay-pause') this.audio.modalOpen();
      const focusable = $(id).querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
      if (focusable.length) setTimeout(() => focusable[0].focus(), 40);
      const trap = (e) => {
        if (e.key !== 'Tab') return;
        const items = Array.from(focusable).filter(x => !x.disabled);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      $(id)._trap = trap;
      $(id).addEventListener('keydown', trap);
    }
    _closeOverlay(id) {
      $(id).classList.add('hidden');
      if (id !== 'overlay-pause') this.audio.panelClose();
      if ($(id)._trap) $(id).removeEventListener('keydown', $(id)._trap);
      if (this._lastFocus && document.contains(this._lastFocus)) this._lastFocus.focus();
      this._lastFocus = null;
    }
    _closeAllOverlays() {
      ['overlay-pause', 'overlay-round', 'overlay-results'].forEach(id => $(id).classList.add('hidden'));
    }

    pauseGame() {
      if (!this.game || this.screen !== 'game') return;
      this.game.pause();
      this.audio.gamePause();
      this._openOverlay('overlay-pause');
      this._announce('Paused.');
    }
    resumeGame() {
      this._closeOverlay('overlay-pause');
      this.audio.gameResume();
      if (this.game) this.game.resume();
      this._announce('Resumed. ' + (this.game && this.game.buildView().myTurn ? 'Your turn.' : ''));
    }

    leaveMatch() {
      this._closeAllOverlays();
      if (this.game) {
        // save a resumable snapshot for Continue
        if (this.game.state && this.game.state.phase === 'active' && this.game.mode !== 'tutorial') {
          this.store.doc.savedMatch = {
            mode: this.game.mode, content: this.game.content, config: this.game.config,
            stateJson: R().serialize(this.game.state), elapsedMs: this.game._elapsedMs,
          };
        } else {
          this.store.doc.savedMatch = null;
        }
        this.store.saveNow();
        this.game.leave();
        this.game = null;
      }
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
      this.audio.stopAll();
      this._toTitle();
    }

    _toTitle() {
      if (this.game) { this.game.leave(); this.game = null; }
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
      this.audio.stopAll();
      this.audio.back();
      this.refreshTitle();
      this.showScreen('title');
    }

    _continueSaved() {
      const sm = this.store.doc.savedMatch;
      if (!sm) return;
      // Restore into a fresh session using the saved config, then swap state.
      this._startMatch(sm.mode, sm.content, sm.config);
      this.game.state = R().deserialize(sm.stateJson);
      this.game._elapsedMs = sm.elapsedMs || 0;
      this.store.doc.savedMatch = null;
      this.store.saveNow();
      this.game._emitView(true);
      this.game._maybeRunAI();
      this._announce('Match restored. ' + (this.game.buildView().myTurn ? 'Your turn.' : this.game.state.players[this.game.state.turn].name + ' to play.'));
    }

    _retry() {
      const mode = this.game ? this.game.mode : 'practice';
      const content = this.game ? this.game.content : null;
      const config = this.game ? this.game.config : null;
      this._closeOverlay('overlay-results');
      P().telemetry.event('retry', { mode });
      if (mode === 'daily') this._setupDaily();
      else if (mode === 'journey' && content) this._startJourneyStage(content);
      else if (mode === 'challenge' && content) {
        this._startMatch('challenge', content, C().challengeToConfig(content, this.store.profile.name));
      } else if (mode === 'tutorial' && content) this._startTutorial(content);
      else if (config) this._startMatch(mode, content, Object.assign({}, config, { seed: 'practice:' + Date.now() }));
    }

    _nextStage() {
      if (!this.game || !this.game.content || !this.game.content.number) return;
      const next = C().JOURNEY.find(s => s.number === this.game.content.number + 1);
      this._closeOverlay('overlay-results');
      if (next) this._startJourneyStage(next); else this._toTitle();
    }

    _showRoundOverlay(rr) {
      if (this.game && this.game.mode === 'tutorial') return; // lessons flow on
      const me = this.game ? Math.max(0, this.game._humanIndex()) : 0;
      const box = $('round-breakdown');
      box.innerHTML = '';
      const head = el('div', 'row head');
      head.appendChild(el('span', '', rr.reason === 'domino' ? 'Domino!' : 'Blocked round'));
      head.appendChild(el('span', 'pts', 'points'));
      box.appendChild(head);
      rr.pipTotals.forEach((pips, p) => {
        const row = el('div', 'row' + (rr.winners.includes(p) ? ' winner' : ''));
        const name = this.game.state.players[p].name + (p === me ? ' (you)' : '');
        row.appendChild(el('span', '', name + ' held ' + pips + ' pips'));
        const b = rr.breakdown.find(x => x.player === p);
        row.appendChild(el('span', 'pts', b ? '+' + b.points : '0'));
        box.appendChild(row);
      });
      const scoreRow = el('div', 'row head');
      scoreRow.appendChild(el('span', '', 'Match score'));
      scoreRow.appendChild(el('span', '', this.game.state.players.map(pl => pl.name + ' ' + pl.score).join(' · ')));
      box.appendChild(scoreRow);
      if (this.game.state.phase === 'round-over') this._openOverlay('overlay-round');
    }

    _showResults(res) {
      const t = res.terminal;
      $('results-heading').textContent = res.won
        ? (this.game.mode === 'tutorial' ? 'Lesson complete!' : 'You win the table!')
        : t.tied ? 'Dead even' : res.players[t.winner].name + ' takes the table';
      this._setResultsArt(res.won ? 'assets/results-win.webp' : 'assets/results-over.webp');
      // stars
      const stars = $('results-stars');
      stars.textContent = res.stars ? '★'.repeat(res.stars) + '☆'.repeat(3 - res.stars) : '';
      for (let i = 0; i < res.stars; i++) this.audio.star(0.4 + i * 0.35);
      // breakdown — component scores, not one unexplained total
      const box = $('results-breakdown');
      box.innerHTML = '';
      const head = el('div', 'row head');
      head.appendChild(el('span', '', 'Final score'));
      head.appendChild(el('span', 'pts', 'pts'));
      box.appendChild(head);
      t.ranking.forEach(rk => {
        const pl = res.players[rk.player];
        const row = el('div', 'row' + (rk.player === t.winner ? ' winner' : ''));
        row.appendChild(el('span', '', pl.name + (rk.player === res.me ? ' (you)' : '') +
          ' — ' + pl.plays + ' plays, ' + pl.draws + ' draws, ' + pl.invalidActions + ' invalid'));
        row.appendChild(el('span', 'pts', String(pl.score)));
        box.appendChild(row);
      });
      const reasonText = {
        'target-reached': 'Target score reached', 'rounds-exhausted': 'Round limit reached',
        'move-limit': 'Move limit reached', 'time-expired': 'Time expired',
      }[t.reason] || t.reason;
      $('results-meta').textContent = reasonText + ' · ' + t.rounds + ' rounds · ' +
        fmtTime(res.elapsedMs) + ' · seed ' + this.game._replay.seed;
      const un = $('results-unlocks');
      un.innerHTML = '';
      res.unlocked.forEach(a => {
        un.appendChild(el('div', 'unlock-chip', '🏆 ' + a.name + ' — ' + a.desc));
      });
      $('btn-results-next').classList.toggle('hidden',
        !(this.game.mode === 'journey' && res.won && this.game.content && this.game.content.number < 40));
      $('btn-results-retry').textContent = this.game.mode === 'tutorial' ? 'Next lesson' : 'Play again';
      this._resultsRetryOverride = null;
      this._openOverlay('overlay-results');
      if (res.unlocked.length) { this.audio.success(); this._toast('Achievement unlocked: ' + res.unlocked[0].name); }
    }

    // Results illustration (assets/results-*.webp): decorative; the img's
    // onerror hides it again if the asset is missing.
    _setResultsArt(src) {
      const img = $('results-art');
      if (!img) return;
      if (!src) { img.classList.add('hidden'); img.removeAttribute('src'); return; }
      img.classList.remove('hidden');
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }

    _showTutorialComplete(def) {
      // finish the lesson: results overlay with outro and next lesson link
      this._setResultsArt('assets/results-win.webp');
      const idx = C().TUTORIALS.findIndex(t => t.id === def.id);
      const next = C().TUTORIALS[idx + 1];
      $('results-heading').textContent = def.title + ' — complete';
      $('results-stars').textContent = '';
      $('results-breakdown').innerHTML = '';
      $('results-breakdown').appendChild(el('p', '', def.outro));
      $('results-unlocks').innerHTML = '';
      $('results-meta').textContent = 'Lessons completed: ' + this.store.progress.tutorials.length + '/6';
      $('btn-results-next').classList.add('hidden');
      $('btn-results-retry').textContent = next ? 'Next lesson' : 'Journey';
      this._resultsRetryOverride = () => {
        this._closeOverlay('overlay-results');
        if (next) this._startTutorial(next); else this._nav('journey');
      };
      this._openOverlay('overlay-results');
    }

    _toast(text) {
      const t = $('overlay-achievement');
      t.textContent = text;
      t.classList.remove('hidden');
      this.audio.toast();
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
      this._announce(text);
    }

    _showCaption(text) {
      const c = $('overlay-captions');
      c.textContent = '♪ ' + text;
      c.classList.add('show');
      clearTimeout(this._captionTimer);
      this._captionTimer = setTimeout(() => c.classList.remove('show'), 1200);
    }

    _announce(text, kind) {
      $(kind === 'error' ? 'sr-assertive' : 'sr-live').textContent = text;
    }

    /* ----------------------------------------------------------- profile */
    _buildProfile() {
      const hostedProfile = P().host.profile && !P().host.profile.guest ? P().host.profile : null;
      $('input-name').value = hostedProfile ? hostedProfile.name : this.store.profile.name;
      $('input-name').disabled = !!hostedProfile;
      const syncTxt = P().host.sync === 'synced' ? 'cloud save synced'
        : P().host.sync === 'saving' ? 'saving…'
        : 'cloud sync unavailable';
      $('profile-kind').textContent = hostedProfile
        ? 'Signed in as ' + hostedProfile.name + ' — ' + syncTxt + '. The name comes from your platform profile.'
        : 'Guest profile — progress is stored on this device. Launch from the platform for cloud saves.';
      const st = this.store.progress.stats;
      const dl = $('stats-list');
      dl.innerHTML = '';
      [['Matches', st.matches], ['Wins', st.wins], ['Win rate', st.matches ? Math.round(100 * st.wins / st.matches) + '%' : '—'],
       ['Current streak', st.streak], ['Best streak', st.bestStreak], ['Rounds played', st.rounds],
       ['Dominos', st.dominos], ['Daily tables', Object.keys(this.store.progress.daily).length],
       ['Mastery stars', Object.values(this.store.progress.journey).reduce((s, v) => s + v.stars, 0)],
      ].forEach(([k, v]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(v))); });
      const al = $('achievements-list');
      al.innerHTML = '';
      P().ACHIEVEMENTS.forEach(a => {
        const got = !!this.store.progress.achievements[a.key];
        const li = el('li', got ? 'unlocked' : '');
        li.appendChild(el('span', 'ach-icon', got ? '🏆' : '○'));
        li.appendChild(el('span', '', a.name + ' — ' + a.desc));
        al.appendChild(li);
      });
      $('panel-conflict').classList.toggle('hidden', !this.store.conflict);
      this._buildLeaderboard(document.querySelector('.lb-tab.active') ? document.querySelector('.lb-tab.active').dataset.lb : 'local');
    }

    async _buildLeaderboard(kind) {
      const list = $('leaderboard-list');
      list.innerHTML = '';
      $('lb-note').textContent = '';
      if (kind === 'local') {
        const board = P().localBoard().slice(0, 20);
        if (!board.length) list.appendChild(el('li', 'muted', 'No scores yet — play a ranked table.'));
        board.forEach(e => list.appendChild(el('li', '', e.name + ' — ' + e.score + ' pts (' + e.mode + ', ' + fmtTime(e.durationMs || 0) + ')')));
        $('lb-note').textContent = 'Stored on this device only.';
      } else {
        // Platform leaderboard (read-only): no leaderboardId -> local records.
        const res = await P().host.fetchLeaderboard();
        (res.entries || []).slice(0, 20).forEach(e =>
          list.appendChild(el('li', '', e.name + ' — ' + e.score + ' pts')));
        if (!res.entries || !res.entries.length) list.appendChild(el('li', 'muted', 'No entries yet.'));
        $('lb-note').textContent = res.local
          ? (res.reason === 'no-leaderboard'
            ? 'This game has no platform leaderboard — personal bests live on this device and in your cloud save.'
            : 'Platform board unavailable — showing nothing yet.')
          : '';
      }
    }

    _saveName() {
      const v = $('input-name').value.trim().slice(0, 24);
      if (!v) return;
      this.store.doc.profile.name = v;
      this.store.saveNow();
      this._announce('Name saved.');
      this._toast('Name saved: ' + v);
    }

    /* -------------------------------------------------------------- help */
    _buildHelp() {
      const b = $('help-body');
      b.innerHTML = '';
      const cards = [
        ['The chain', 'Tiles connect when touching ends show the same number. Each turn, play one tile on either open end. The open values are shown as large numbers beside the chain.'],
        ['Your hand', 'Tap a tile to select it, then tap an end marker to place it. Tiles you can legally play stay bright; others dim. Double-tap a tile with only one legal end to play it instantly.'],
        ['Doubles', 'Doubles sit crosswise on the chain. The open value stays the same on that side.'],
        ['Drawing & passing', 'No playable tile? Draw from the boneyard. If the boneyard is empty (or the table forbids drawing), pass. When every player passes in a row, the round is blocked.'],
        ['Scoring', 'Empty your hand to go "domino" and score every pip left in other hands. In a blocked round, the lowest remaining pip total wins the margin. First to the target score takes the match.'],
      ];
      cards.forEach(([h, t]) => {
        const c = el('section', 'rule-card');
        c.appendChild(el('h3', '', h));
        c.appendChild(el('p', '', t));
        b.appendChild(c);
      });
      // controls card generated from current bindings
      const s = this.store.settings.bindings;
      const c = el('section', 'rule-card');
      c.appendChild(el('h3', '', 'Controls'));
      const demo = el('div', 'rule-demo');
      [['Select / confirm', s.confirm], ['Cancel / pause', s.cancel + ' / ' + s.pause],
       ['Left end / right end', s.endLeft + ' / ' + s.endRight], ['Draw / pass', s.draw + ' / ' + s.pass],
       ['Undo / hint', s.undo + ' / ' + s.hint], ['Reset camera', s.cameraReset],
      ].forEach(([k, v]) => {
        const d = el('div', '', '');
        d.innerHTML = '<kbd>' + v + '</kbd> ' + k;
        demo.appendChild(d);
      });
      c.appendChild(demo);
      c.appendChild(el('p', 'muted', 'Gamepad: D-pad or left stick moves focus, A confirms, B cancels, Start pauses, X draws, Y hints.'));
      b.appendChild(c);
    }

    /* ---------------------------------------------------------- keyboard */
    _bindKeyboard() {
      window.addEventListener('keydown', (e) => {
        if (this.screen !== 'game' || !this.game) return;
        if (document.querySelector('.overlay:not(.hidden)')) {
          // Escape only closes the pause overlay; the round and results
          // overlays are decision points and need an explicit choice.
          if (e.key === 'Escape' && !$('overlay-pause').classList.contains('hidden')) {
            e.preventDefault();
            this.resumeGame();
          }
          return;
        }
        const B = this.store.settings.bindings;
        const code = e.code;
        const view = this.game.buildView();
        if (code === B.pause || (code === B.cancel && !this.game.selectedTile && this.game.selectedTile !== 0)) {
          if (code === B.pause) { e.preventDefault(); this.pauseGame(); return; }
        }
        if (code === B.undo) { e.preventDefault(); this.game.undo(); return; }
        if (code === B.hint) { e.preventDefault(); this.game.hint(); return; }
        if (code === B.cameraReset) { if (this.renderer) this.renderer.resetCamera(); return; }
        if (!view || !view.myTurn) return;

        const hand = view.myHand;
        const cur = this.game.selectedTile;
        const idx = cur === null ? -1 : hand.indexOf(cur);
        if (code === B.navLeft || code === B.navRight) {
          e.preventDefault();
          const dir = code === B.navLeft ? -1 : 1;
          const next = idx < 0 ? 0 : Math.min(hand.length - 1, Math.max(0, idx + dir));
          this.audio.scrollTick();
          this.game.selectTile(hand[next]);
          // move DOM focus to match
          const li = $('hand-list').children[next];
          if (li) li.querySelector('.domino').focus();
          return;
        }
        if (code === B.endLeft) { e.preventDefault(); this._commitToEnd('left'); return; }
        if (code === B.endRight) { e.preventDefault(); this._commitToEnd('right'); return; }
        if (code === B.draw && view.canDraw) { e.preventDefault(); this._doAction({ type: 'draw' }); return; }
        if (code === B.pass && view.canPass) { e.preventDefault(); this._doAction({ type: 'pass' }); return; }
        if (code === B.confirm && cur !== null) {
          e.preventDefault();
          if (view.legalEnds.length === 1) this._commitToEnd(view.legalEnds[0]);
          return;
        }
        if (code === B.cancel && cur !== null) {
          e.preventDefault();
          this.game.selectTile(cur); // toggles off
          return;
        }
      });
    }

    /* ---------------------------------------------------------- gamepad */
    _bindGamepad() {
      const poll = () => {
        if (this.screen === 'game' && this.game && !this.game.paused) {
          const pads = navigator.getGamepads ? navigator.getGamepads() : [];
          const gp = this._gamepad.idx !== null ? pads[this._gamepad.idx] : Array.from(pads).find(p => p);
          if (gp) {
            this._gamepad.idx = gp.index;
            this._gpButtons(gp);
          }
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      window.addEventListener('gamepadconnected', (e) => { this._gamepad.idx = e.gamepad.index; this._toast('Gamepad connected'); });
      window.addEventListener('gamepaddisconnected', () => { this._gamepad.idx = null; });
    }

    _gpButtons(gp) {
      const prev = this._gamepad.prev;
      const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed && !prev[i];
      const view = this.game.buildView();
      const hand = view ? view.myHand : [];
      const cur = this.game.selectedTile;
      const idx = cur === null ? -1 : hand.indexOf(cur);
      const axisX = gp.axes[0] || 0;
      const now = performance.now();
      if (!this._gamepad.axisAt) this._gamepad.axisAt = 0;

      const nav = (dir) => {
        const next = idx < 0 ? 0 : Math.min(hand.length - 1, Math.max(0, idx + dir));
        this.audio.scrollTick();
        this.game.selectTile(hand[next]);
      };
      if (pressed(14) || (axisX < -0.6 && now - this._gamepad.axisAt > 220)) { nav(-1); this._gamepad.axisAt = now; }
      if (pressed(15) || (axisX > 0.6 && now - this._gamepad.axisAt > 220)) { nav(1); this._gamepad.axisAt = now; }
      if (pressed(0)) { // A: confirm
        if (cur !== null && view.legalEnds.length === 1) this._commitToEnd(view.legalEnds[0]);
        else if (cur === null && hand.length) this.game.selectTile(hand[0]);
      }
      if (pressed(1)) { // B: cancel / deselect
        if (cur !== null) this.game.selectTile(cur);
      }
      if (pressed(9)) this.pauseGame();                    // Start
      if (pressed(2) && view && view.canDraw) this._doAction({ type: 'draw' });   // X
      if (pressed(3)) this.game.hint();                    // Y
      if (pressed(4)) this._commitToEnd('left');           // LB
      if (pressed(5)) this._commitToEnd('right');          // RB
      gp.buttons.forEach((b, i) => { prev[i] = b.pressed; });
    }

    /* --------------------------------------------------------- lifecycle */
    _bindLifecycle() {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (this.game && this.screen === 'game' && !this.game._finished) {
            // backgrounding pauses solo simulation
            if (document.querySelector('#overlay-pause.hidden')) this.pauseGame();
            if (this.renderer) this.renderer.pause();
          }
          this.audio.suspend();
        } else {
          this.audio.resume();
          if (this.renderer && this.screen === 'game' &&
              !document.querySelector('#overlay-pause.hidden')) { /* stay paused */ }
        }
      });
      window.addEventListener('pagehide', () => {
        if (this.game && this.game.state && this.game.state.phase === 'active' && this.game.mode !== 'tutorial') {
          this.store.doc.savedMatch = {
            mode: this.game.mode, content: this.game.content, config: this.game.config,
            stateJson: R().serialize(this.game.state), elapsedMs: this.game._elapsedMs,
          };
          this.store.saveNow();
        }
      });
      window.addEventListener('resize', () => { if (this.renderer) this.renderer.resize(); });
      window.addEventListener('orientationchange', () => setTimeout(() => { if (this.renderer) this.renderer.resize(); }, 120));
      window.addEventListener('error', (e) => {
        P().telemetry.event('error', { category: 'runtime' });
      });
    }

    _heartbeat() {
      // No presence endpoint exists for launch tokens (wiki) — removed.
      if (this._hbTimer) clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  root.ChainDominoesUI = { UI, dominoEl };
})(typeof self !== 'undefined' ? self : globalThis);
