/* Chain Dominoes — audio. One-shot event sounds are samples from sfx/
 * (see sfx/manifest.md), decoded into buffers after the first user gesture;
 * the original procedural WebAudio synthesis below remains as the fallback
 * until a sample loads or if it is unavailable. No other external assets.
 * Buses: music / effects / ambience / voice (voice reserved for host
 * captions; slider honored). Event sounds use a seeded variant stream so
 * replays sound identical.
 */
(function (root) {
  'use strict';

  const BUS_NAMES = ['music', 'effects', 'ambience', 'voice'];

  // Sampled one-shots (sfx/*.opus, see sfx/manifest.md). Loaded lazily after
  // the AudioContext exists; until a buffer is ready (or if loading fails)
  // the procedural synthesis below is used instead, so playback never breaks.
  const SAMPLE_FILES = [
    'ui-click', 'ui-hover', 'ui-confirm', 'ui-back', 'ui-error', 'ui-success',
    'ui-modal-open', 'ui-toggle', 'tile-place', 'tile-draw', 'pass-knock',
    'round-win', 'round-lose', 'match-win', 'tab-switch', 'panel-close',
    'toast-notification', 'game-pause', 'game-resume', 'timer-warning',
    'slider-drag', 'tile-pickup', 'tile-shuffle', 'tile-deal', 'round-start',
    'move-undo', 'hint-glow', 'star-award', 'new-record', 'opponent-turn',
    'scroll-tick', 'tile-flip', 'countdown-tick', 'combo-low', 'combo-mid',
    'combo-high',
  ];

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buses = {};
      this.volumes = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 };
      this.muted = false;
      this.rng = null;          // seeded variant stream (session 'av')
      this._musicTimer = null;
      this._ambNodes = null;
      this._started = false;
      this._lastCaption = '';
      this._samples = {};          // name -> AudioBuffer | null (failed) | undefined (loading)
      this._samplesRequested = false;
      this._comboStreak = 0;        // successive plays close together = chain run
      this._lastPlaceAt = -10;
      this.onCaption = null;    // (text) => void, for visual cue mirroring
    }

    // Must be called from a user gesture.
    init() {
      if (this.ctx) return true;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      for (const b of BUS_NAMES) {
        const g = this.ctx.createGain();
        g.gain.value = this.volumes[b];
        g.connect(this.master);
        this.buses[b] = g;
      }
      this._loadSamples();
      return true;
    }

    /* ------------------------------------------------- sample one-shots */
    _loadSamples() {
      if (this._samplesRequested || typeof fetch !== 'function') return;
      this._samplesRequested = true;
      const base = (typeof document === 'object' && document.baseURI) ? document.baseURI : undefined;
      SAMPLE_FILES.forEach(name => {
        const url = base ? new URL('sfx/' + name + '.opus', base).href : 'sfx/' + name + '.opus';
        fetch(url)
          .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
          .then(ab => this.ctx.decodeAudioData(ab))
          .then(buf => { this._samples[name] = buf; })
          .catch(() => { this._samples[name] = null; }); // stay on synthesis
      });
    }

    // Play a loaded sample on the effects bus. Returns false while the buffer
    // is unavailable (still loading or failed) so callers can fall back.
    _sample(name, delay) {
      if (!this.ctx) return false;
      const buf = this._samples[name];
      if (!buf) return false;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.buses.effects);
      src.start(this.ctx.currentTime + (delay || 0));
      return true;
    }

    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
    suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }

    setSeedStream(rng) { this.rng = rng; }
    _variant(base, spread) {
      const r = this.rng ? this.rng.next() : Math.random();
      return base * (1 - spread / 2 + r * spread);
    }

    setVolume(bus, v) {
      this.volumes[bus] = v;
      if (this.buses[bus]) this.buses[bus].gain.value = v;
    }
    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 1;
    }

    _caption(text) {
      this._lastCaption = text;
      if (this.onCaption) this.onCaption(text);
    }

    /* ------------------------------------------------ primitive builders */
    _env(node, t0, a, peak, d, sustainLevel, r) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), t0 + a + d);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d + r);
      node.connect(g);
      return g;
    }

    _osc(type, freq, t0, dur, gainPeak, dest) {
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.setValueAtTime(freq, t0);
      const g = this._env(o, t0, 0.005, gainPeak, dur * 0.6, gainPeak * 0.2, dur * 0.4);
      g.connect(dest);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }

    _noise(t0, dur, filterFreq, q, gainPeak, dest, type) {
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = type || 'bandpass'; f.frequency.value = filterFreq; f.Q.value = q;
      const g = this._env(f, t0, 0.002, gainPeak, dur * 0.5, gainPeak * 0.1, dur * 0.5);
      src.connect(f); g.connect(dest);
      src.start(t0);
    }

    /* ------------------------------------------------------- game events */
    // Acknowledgment tick — every input, below 100 ms feel.
    ack() {
      if (!this.ctx) return;
      if (this._sample('ui-click')) { this._caption('tap'); return; }
      this._osc('sine', this._variant(880, 0.06), this.ctx.currentTime, 0.06, 0.08, this.buses.effects);
      this._caption('tap');
    }
    select() {
      if (!this.ctx) return;
      if (this._sample('tile-pickup')) { this._caption('select'); return; }
      this._osc('triangle', this._variant(660, 0.05), this.ctx.currentTime, 0.07, 0.1, this.buses.effects);
      this._caption('select');
    }
    // Ceramic clack: layered noise burst + body thump. Plays in quick
    // succession escalate a combo cascade (combo-low/mid/high samples).
    place() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this._comboStreak = (t - this._lastPlaceAt < 2.6) ? this._comboStreak + 1 : 0;
      this._lastPlaceAt = t;
      const combo = this._comboStreak >= 6 ? 'combo-high'
        : this._comboStreak >= 4 ? 'combo-mid'
        : this._comboStreak >= 2 ? 'combo-low' : null;
      const comboPlayed = combo ? this._sample(combo, 0.06) : false;
      if (this._sample('tile-place')) { this._caption(comboPlayed ? 'chain run' : 'tile placed'); return; }
      this._noise(t, 0.05, this._variant(3200, 0.3), 6, 0.5, this.buses.effects, 'highpass');
      this._osc('sine', this._variant(190, 0.12), t, 0.12, 0.35, this.buses.effects);
      this._osc('triangle', this._variant(1200, 0.2), t, 0.03, 0.12, this.buses.effects);
      this._caption(comboPlayed ? 'chain run' : 'tile placed');
    }
    draw() {
      if (!this.ctx) return;
      this._comboStreak = 0;
      const drew = this._sample('tile-draw');
      this._sample('tile-flip', 0.25); // drawn tile turned face-up in hand
      if (drew) { this._caption('draw from boneyard'); return; }
      const t = this.ctx.currentTime;
      this._noise(t, 0.09, this._variant(1400, 0.2), 2, 0.2, this.buses.effects);
      this._osc('sine', this._variant(320, 0.1), t + 0.03, 0.08, 0.12, this.buses.effects);
      this._caption('draw from boneyard');
    }
    pass() {
      if (!this.ctx) return;
      this._comboStreak = 0;
      if (this._sample('pass-knock')) { this._caption('pass'); return; }
      this._osc('sine', this._variant(240, 0.05), this.ctx.currentTime, 0.18, 0.12, this.buses.effects);
      this._caption('pass');
    }
    invalid() {
      if (!this.ctx) return;
      if (this._sample('ui-error')) { this._caption('not allowed'); return; }
      const t = this.ctx.currentTime;
      this._osc('square', 140, t, 0.09, 0.06, this.buses.effects);
      this._osc('square', 110, t + 0.09, 0.12, 0.06, this.buses.effects);
      this._caption('not allowed');
    }
    hint() {
      if (!this.ctx) return;
      if (this._sample('hint-glow')) { this._caption('hint'); return; }
      const t = this.ctx.currentTime;
      this._osc('sine', 720, t, 0.1, 0.07, this.buses.effects);
      this._osc('sine', 960, t + 0.09, 0.14, 0.07, this.buses.effects);
      this._caption('hint');
    }
    roundWin() {
      if (!this.ctx) return;
      if (this._sample('round-win')) { this._caption('round won'); return; }
      const t = this.ctx.currentTime;
      [523, 659, 784].forEach((f, i) => this._osc('triangle', f, t + i * 0.09, 0.22, 0.12, this.buses.effects));
      this._caption('round won');
    }
    roundLose() {
      if (!this.ctx) return;
      if (this._sample('round-lose')) { this._caption('round lost'); return; }
      const t = this.ctx.currentTime;
      [392, 330].forEach((f, i) => this._osc('triangle', f, t + i * 0.12, 0.25, 0.1, this.buses.effects));
      this._caption('round lost');
    }
    matchWin() {
      if (!this.ctx) return;
      if (this._sample('match-win')) { this._caption('match won'); return; }
      const t = this.ctx.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => this._osc('triangle', f, t + i * 0.11, 0.3, 0.13, this.buses.effects));
      this._noise(t + 0.4, 0.3, 4000, 2, 0.1, this.buses.effects, 'highpass');
      this._caption('match won');
    }
    matchLose() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      [440, 349, 294].forEach((f, i) => this._osc('triangle', f, t + i * 0.14, 0.3, 0.1, this.buses.effects));
      this._caption('match lost');
    }
    turnYou() {
      if (!this.ctx) return;
      this._osc('sine', this._variant(590, 0.03), this.ctx.currentTime, 0.09, 0.06, this.buses.effects);
      this._caption('your turn');
    }

    /* ------------------------------------- sample-only one-shots (sfx/) */
    hover() { this._sample('ui-hover'); }
    confirm() { if (this._sample('ui-confirm')) this._caption('confirmed'); }
    back() { this._sample('ui-back'); }
    success() { if (this._sample('ui-success')) this._caption('achievement'); }
    modalOpen() { this._sample('ui-modal-open'); }
    panelClose() { this._sample('panel-close'); }
    toggle() { this._sample('ui-toggle'); }
    tabSwitch() { this._sample('tab-switch'); }
    scrollTick() { this._sample('scroll-tick'); }
    sliderDrag() { this._sample('slider-drag'); }
    toast() { this._sample('toast-notification'); }
    gamePause() { if (this._sample('game-pause')) this._caption('paused'); }
    gameResume() { if (this._sample('game-resume')) this._caption('resumed'); }
    timerWarning() { if (this._sample('timer-warning')) this._caption('time running out'); }
    countdownTick() { if (this._sample('countdown-tick')) this._caption('countdown'); }
    opponentTurn() { if (this._sample('opponent-turn')) this._caption('opponent’s turn'); }
    star(delay) { this._sample('star-award', delay); }
    newRecord() { if (this._sample('new-record')) this._caption('new record'); }
    undoMove() {
      if (!this.ctx) return;
      if (this._sample('move-undo')) { this._caption('undone'); return; }
      this.ack();
    }
    // Round begins: boneyard shuffle, the deal, then the start chime.
    roundIntro() {
      if (!this.ctx) return;
      this._sample('tile-shuffle');
      this._sample('tile-deal', 1.0);
      if (this._sample('round-start', 2.0)) this._caption('round begins');
    }

    /* ------------------------------------------- ambience & adaptive music */
    startAmbience() {
      if (!this.ctx || this._ambNodes) return;
      // Quiet café room tone: low-passed brown-ish noise + faint clink LFO.
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 420;
      const g = this.ctx.createGain(); g.gain.value = 0.16;
      src.connect(f); f.connect(g); g.connect(this.buses.ambience);
      src.start();
      this._ambNodes = { src, g };
    }
    stopAmbience() {
      if (this._ambNodes) { try { this._ambNodes.src.stop(); } catch (e) { /* ok */ } this._ambNodes = null; }
    }

    // Generative two-chord pad stem; tension rises slightly near match point.
    startMusic() {
      if (!this.ctx || this._musicTimer) return;
      const chords = [
        [261.6, 329.6, 392.0],   // C
        [220.0, 261.6, 329.6],   // Am
        [174.6, 220.0, 261.6],   // F
        [196.0, 246.9, 293.7],   // G
      ];
      let step = 0;
      const playChord = () => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const ch = chords[step % chords.length];
        ch.forEach(f => {
          const o = this.ctx.createOscillator();
          o.type = 'sine'; o.frequency.value = f * (this.rng ? (0.999 + this.rng.next() * 0.002) : 1);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.045, t + 0.8);
          g.gain.linearRampToValueAtTime(0.0001, t + 3.4);
          o.connect(g); g.connect(this.buses.music);
          o.start(t); o.stop(t + 3.6);
        });
        step++;
      };
      playChord();
      this._musicTimer = setInterval(playChord, 3400);
    }
    stopMusic() {
      if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    }

    startAll() {
      if (!this.ctx) return;
      if (this._started) return;
      this._started = true;
      this.startAmbience();
      this.startMusic();
    }
    stopAll() {
      this._started = false;
      this.stopAmbience();
      this.stopMusic();
    }
  }

  const api = new AudioEngine();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesAudio = api;
})(typeof self !== 'undefined' ? self : globalThis);
