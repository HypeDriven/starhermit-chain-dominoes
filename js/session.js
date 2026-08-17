/* Chain Dominoes — session controller.
 * Owns one match: applies validated commands to the rules engine, schedules
 * AI turns, runs the tutorial step engine, manages undo/hints, timers,
 * the replay envelope, and results/progression. Rendering consumes
 * immutable view snapshots built here; no UI code mutates rules state.
 */
(function (root, factory) {
  const deps = typeof module === 'object' && module.exports
    ? { R: require('./rules.js'), C: require('./content.js'), AI: require('./ai.js'), P: require('./platform.js') }
    : { R: root.ChainDominoesRules, C: root.ChainDominoesContent, AI: root.ChainDominoesAI, P: root.ChainDominoesPlatform };
  const api = factory(deps.R, deps.C, deps.AI, deps.P);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesSession = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R, C, AI, P) {
  'use strict';

  const BUILD_VERSION = '1.0.0';

  class Session {
    constructor(opts) {
      this.store = opts.store;
      this.audio = opts.audio || null;
      this.renderer = null;            // attached by UI when 3D is available
      // UI callbacks
      this.onView = null;              // (view) => {}
      this.onAnnounce = null;          // (text, kind) => {}
      this.onEvent = null;             // (name, payload) => {}  (round-end, results, tutorial, invalid...)
      this.state = null;
      this.mode = null;                // 'tutorial'|'journey'|'daily'|'practice'|'challenge'
      this.content = null;             // stage/challenge/daily/tutorial def
      this.config = null;
      this.options = { undo: true, hints: true, ranked: false, timeLimitSec: 0 };
      this.paused = false;
      this._aiTimer = null;
      this._actionIds = new Set();     // idempotent command dedupe
      this._undoStack = [];
      this._replay = null;
      this._tutorial = null;           // {def, stepIdx}
      this._elapsedMs = 0;
      this._tickTimer = null;
      this._startedAt = 0;
      this._aiRng = null;
      this.selectedTile = null;
      this._finished = false;
    }

    /* ------------------------------------------------------------ start */
    startMatch(mode, content, config, options) {
      this.leave();
      this.mode = mode;
      this.content = content || null;
      this.config = config;
      this.options = Object.assign({ undo: true, hints: true, ranked: false, timeLimitSec: 0 }, options || {});
      this._finished = false;
      this._undoStack = [];
      this._actionIds = new Set();
      this._elapsedMs = 0;
      this._startedAt = Date.now();

      if (mode === 'tutorial' && content && content.setup) {
        this.state = R.createCustomState(content.setup);
        this._tutorial = { def: content, stepIdx: 0 };
      } else {
        this.state = R.createMatch(config);
      }
      this._aiRng = R.mulberry32(R.hashString(String(config ? config.seed : content.seed) + ':ai'));
      if (this.audio) this.audio.setSeedStream(R.makeStreams(config ? config.seed : 't').av);

      this._replay = {
        version: 1, build: BUILD_VERSION,
        contentVersion: C.CONTENT_VERSION,
        seed: String(config ? config.seed : (content && content.seed) || 'custom'),
        initialHash: R.stateHash(this.state),
        startedAt: this._startedAt,
        commands: [], hashes: [], terminal: null,
      };

      P.telemetry.event('start', { mode });
      this._announce(this._introText());
      this._emitView(true);
      this._emitTutorialStep();
      this._startClock();
      this._maybeRunAI();
      return this.state;
    }

    _introText() {
      const t = this.state.ruleset.targetScore;
      const names = this.state.players.map(p => p.name).join(', ');
      if (this.mode === 'tutorial') return this._tutorial.def.intro;
      return (this.content && (this.content.goal || this.content.blurb)) ||
        ('First to ' + (t > 0 ? t : 'the highest score') + '. Players: ' + names + '.');
    }

    /* ------------------------------------------------------------- clock */
    _startClock() {
      this._stopClock();
      let last = Date.now();
      this._tickTimer = setInterval(() => {
        if (this.paused) { last = Date.now(); return; }
        const now = Date.now();
        this._elapsedMs += now - last;
        last = now;
        if (this.options.timeLimitSec > 0 && !this._finished) {
          const limit = this.options.timeLimitSec * 1000 * (this._assist() ? 1.5 : 1);
          if (this._elapsedMs >= limit) {
            this._finishByTimeout();
          } else if (this.onEvent) {
            this.onEvent('clock', { remainingMs: limit - this._elapsedMs });
          }
        }
      }, 250);
    }
    _stopClock() { if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; } }
    _assist() { return !!(this.store && this.store.settings.timingAssist); }

    _finishByTimeout() {
      // Speed challenge: time ran out — match ends immediately, highest score wins.
      const st = this.state;
      st.phase = 'match-over';
      const ranking = R.rankPlayers(st);
      st.terminal = {
        reason: 'time-expired', ranking, winner: ranking[0].player,
        scores: st.players.map(p => p.score), rounds: st.round, ticks: st.tick,
        tied: false,
      };
      this._handleMatchOver();
    }

    /* -------------------------------------------------------------- acts */
    // All human input enters here. actionId makes double commits idempotent.
    act(cmd, actionId) {
      if (!this.state || this.paused || this._finished) return { ok: false, reason: 'inactive' };
      if (actionId) {
        if (this._actionIds.has(actionId)) return { ok: false, reason: 'duplicate' };
        this._actionIds.add(actionId);
      }
      const me = this._humanIndex();
      if (me < 0) return { ok: false, reason: 'no-human' };

      // Tutorial gating: only the expected action type is accepted.
      if (this._tutorial && !this._tutorialAllows(cmd)) {
        return this._reject('follow-the-lesson', cmd);
      }
      const reason = R.invalidReason(this.state, me, cmd);
      if (reason) return this._reject(reason, cmd);

      this._pushUndo();
      const res = R.applyCommand(this.state, me, cmd);
      this._afterCommand(res, cmd);
      return res;
    }

    _reject(reason, cmd) {
      if (this.audio) this.audio.invalid();
      if (this.onEvent) this.onEvent('invalid', { reason, cmd });
      this._announce(this._reasonText(reason), 'error');
      return { ok: false, reason };
    }

    _reasonText(reason) {
      const map = {
        'not-your-turn': 'It is not your turn.',
        'tile-not-in-hand': 'That tile is not in your hand.',
        'no-matching-end': 'That tile does not match that end.',
        'must-play-if-able': 'You have a playable tile — you must play it.',
        'boneyard-empty': 'The boneyard is empty. You must pass.',
        'must-draw-first': 'Draw from the boneyard first.',
        'draw-disabled': 'Drawing is disabled at this table.',
        'draw-limit-one': 'Only one draw per turn at this table.',
        'move-limit-reached': 'You have reached the move limit.',
        'game-over': 'The match is over.',
        'round-over': 'The round is over.',
        'follow-the-lesson': 'Follow the highlighted lesson step.',
        'malformed-command': 'That action is not recognized.',
      };
      return map[reason] || ('Not allowed: ' + reason);
    }

    _afterCommand(res, cmd) {
      if (!res.ok) return;
      const ev = res.event;
      this._replay.commands.push({ tick: this.state.tick, player: ev.player, cmd: { type: cmd.type, tileId: cmd.tileId, end: cmd.end } });
      this._replay.hashes.push({ tick: this.state.tick, hash: R.stateHash(this.state) });
      if (this.audio) {
        if (ev.type === 'play') this.audio.place();
        else if (ev.type === 'draw') this.audio.draw();
        else if (ev.type === 'pass') this.audio.pass();
      }
      this.selectedTile = null;
      this._advanceTutorial(ev);
      if (this.state.phase === 'round-over') this._handleRoundOver();
      else if (this.state.phase === 'match-over') this._handleMatchOver();
      else this._emitView();
      this._maybeRunAI();
    }

    /* ---------------------------------------------------------- AI turns */
    _humanIndex() {
      if (!this.state) return -1;
      return this.state.players.findIndex(p => p.kind === 'human');
    }

    _maybeRunAI() {
      if (!this.state || this._finished || this.paused) return;
      if (this.state.phase !== 'active') return;
      const cur = this.state.players[this.state.turn];
      if (!cur || cur.kind !== 'ai') return;
      const scripted = this._tutorial && cur.difficulty === 'scripted';
      const delay = scripted ? 650 : (this.mode === 'practice' ? 550 : 750) + this._aiRng.next() * 400;
      this._aiTimer = setTimeout(() => this._runOneAI(), delay);
    }

    _runOneAI(fast) {
      if (!this.state || this._finished || this.paused) return;
      if (this.state.phase !== 'active') return;
      const p = this.state.turn;
      const pl = this.state.players[p];
      if (!pl || pl.kind !== 'ai') return;
      const move = AI.chooseMove(this.state, p, pl.difficulty === 'scripted' ? 'easy' : pl.difficulty, this._aiRng);
      if (!move) return;
      const res = R.applyCommand(this.state, p, move);
      if (!res.ok) { // should never happen; AI uses legal-action API
        this._runOneAI(fast);
        return;
      }
      if (this.audio && !fast) {
        const ev = res.event;
        if (ev.type === 'play') this.audio.place();
        else if (ev.type === 'draw') this.audio.draw();
        else if (ev.type === 'pass') this.audio.pass();
      }
      this._replay.commands.push({ tick: this.state.tick, player: p, cmd: { type: move.type, tileId: move.tileId, end: move.end } });
      if (this._tutorial) this._advanceTutorial(res.event);
      if (this.state.phase === 'round-over') { this._handleRoundOver(); return; }
      if (this.state.phase === 'match-over') { this._handleMatchOver(); return; }
      this._emitView();
      if (this.state.players[this.state.turn].kind === 'ai') {
        if (fast) this._runOneAI(true);
        else this._maybeRunAI();
      } else if (this.audio && !fast) {
        this.audio.turnYou();
      }
      if (this.state.players[this.state.turn].kind === 'human') {
        this._announceTurn();
      }
    }

    _announceTurn() {
      const st = this.state;
      const acts = R.legalActions(st, st.turn);
      const kinds = new Set(acts.map(a => a.type));
      let msg = 'Your turn. ';
      if (kinds.has('play')) msg += 'Ends are ' + st.leftEnd + ' and ' + st.rightEnd + '.';
      else if (kinds.has('draw')) msg += 'No matching tile — draw from the boneyard.';
      else msg += 'No moves — you must pass.';
      this._announce(msg);
    }

    // Finish instantly (skip/fast-forward): settle every object into the
    // exact deterministic end state.
    skipToSettled() {
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      let guard = 0;
      while (this.state && this.state.phase === 'active' &&
             this.state.players[this.state.turn].kind === 'ai' && guard++ < 500) {
        this._runOneAI(true);
      }
      if (this.renderer) this.renderer.settle();
      this._emitView(true);
    }

    /* ------------------------------------------------------ round / match */
    _handleRoundOver() {
      const rr = this.state.roundResult;
      const me = this._humanIndex();
      if (this.store) {
        this.store.progress.stats.rounds += 1;
        if (rr.reason === 'domino' && rr.winners.includes(me)) this.store.progress.stats.dominos += 1;
        this.store.saveNow();
      }
      P.telemetry.event('round-end', { reason: rr.reason, points: rr.breakdown.map(b => b.points) });
      if (this.audio) {
        if (rr.winners.includes(me)) this.audio.roundWin(); else this.audio.roundLose();
        if (this.renderer) { this.renderer.shake(0.15); }
      }
      this._emitView();
      if (this.onEvent) this.onEvent('round-end', rr);
    }

    continueNextRound() {
      if (!this.state || this.state.phase !== 'round-over') return;
      R.nextRound(this.state);
      this._emitView(true);
      this._announce('Round ' + this.state.round + '. ' + this.state.players[this.state.turn].name + ' opens.');
      this._maybeRunAI();
    }

    _handleMatchOver() {
      this._finished = true;
      this._stopClock();
      const st = this.state;
      const me = this._humanIndex();
      const won = st.terminal.winner === me;
      this._replay.terminal = st.terminal;

      // progression + achievements
      const unlocked = [];
      if (this.store) {
        const stats = this.store.progress.stats;
        stats.matches += 1;
        if (won) { stats.wins += 1; stats.streak += 1; stats.bestStreak = Math.max(stats.bestStreak, stats.streak); }
        else stats.streak = 0;
        const u1 = won ? P.unlock(this.store, 'first_win') : null;
        if (u1) unlocked.push(u1);
        if (stats.streak >= 5) { const u = P.unlock(this.store, 'streak_5'); if (u) unlocked.push(u); }
        if (stats.matches >= 100) { const u = P.unlock(this.store, 'marathon_100'); if (u) unlocked.push(u); }

        if (this.mode === 'journey' && won && this.content) {
          const stars = this._starsFor(st, me);
          const prev = this.store.progress.journey[this.content.id] || { stars: 0, bestScore: 0 };
          this.store.progress.journey[this.content.id] = {
            stars: Math.max(prev.stars, stars),
            bestScore: Math.max(prev.bestScore, st.players[me].score),
          };
          this.store.progress.masteryXP += stars;
          if (won && this.content.mastery && this.content.number >= 32) {
            const u = P.unlock(this.store, 'milestone_hard'); if (u) unlocked.push(u);
          }
          const allWon = C.JOURNEY.every(s => (this.store.progress.journey[s.id] || {}).stars > 0);
          if (allWon) { const u = P.unlock(this.store, 'journey_complete'); if (u) unlocked.push(u); }
        }
        if (this.mode === 'daily' && this.content) {
          const key = this.content.dateKey;
          if (!this.store.progress.daily[key]) {
            this.store.progress.daily[key] = { won, score: st.players[me].score };
            const total = Object.keys(this.store.progress.daily).length;
            if (total >= 7) { const u = P.unlock(this.store, 'daily_7'); if (u) unlocked.push(u); }
          }
        }
        this.store.saveNow();
      }

      // score submission: ruleset/content version/seed/assists/duration
      const entry = {
        score: st.players[me] ? st.players[me].score : 0,
        won,
        ruleset: st.ruleset, contentVersion: C.CONTENT_VERSION,
        seed: this._replay.seed, mode: this.mode,
        assists: { hints: this.options.hints, undo: this.options.undo, timingAssist: this._assist() },
        durationMs: this._elapsedMs,
        ticks: st.tick,
      };
      if (this.mode === 'daily' || this.mode === 'challenge' || this.mode === 'journey') {
        P.localSubmit(Object.assign({ name: this.store ? this.store.profile.name : 'You', at: Date.now(), contentId: this.content ? this.content.id : '' }, entry));
        P.host.submitScore(entry).catch(() => {});
      }

      if (this.audio) (won ? this.audio.matchWin() : this.audio.matchLose());
      this._emitView();
      if (this.onEvent) {
        this.onEvent('results', {
          terminal: st.terminal, won, me,
          roundResult: st.roundResult,
          players: st.players,
          entry, unlocked,
          stars: this.mode === 'journey' && won ? this._starsFor(st, me) : 0,
          replay: this._replay,
          elapsedMs: this._elapsedMs,
        });
      }
      this._announce(won ? 'Match won!' : 'Match over. ' + st.players[st.terminal.winner].name + ' wins.');
    }

    _starsFor(st, me) {
      // star 1: win; star 2: win by >= target/2 margin or in par rounds;
      // star 3: no invalid actions
      let stars = 1;
      const opp = Math.max.apply(null, st.players.filter((_, i) => i !== me).map(p => p.score));
      const par = this.content && this.content.par;
      if ((st.players[me].score - opp) >= 20 || (par && st.round <= par.rounds)) stars += 1;
      if (st.players[me].invalidActions === 0) stars += 1;
      return Math.min(3, stars);
    }

    /* -------------------------------------------------------------- undo */
    _pushUndo() {
      if (!this.options.undo) return;
      if (this.mode === 'daily' || this.mode === 'challenge') return; // ranked: no undo
      this._undoStack.push(R.serialize(this.state));
      if (this._undoStack.length > 60) this._undoStack.shift();
    }
    canUndo() {
      return this.options.undo && this._undoStack.length > 0 && !this._finished &&
        this.mode !== 'daily' && this.mode !== 'challenge';
    }
    undo() {
      if (!this.canUndo()) return { ok: false };
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      // Restore to just before the human's last command (AI moves after it
      // are replayed deterministically only if the human repeats choices —
      // simplest fair rule: roll back to the human's previous decision point).
      while (this._undoStack.length) {
        const snap = R.deserialize(this._undoStack.pop());
        this.state = snap;
        if (this.state.phase === 'active' && this.state.players[this.state.turn].kind === 'human') break;
      }
      this.selectedTile = null;
      this._emitView(true);
      this._announce('Undone. Your turn.');
      if (this.audio) this.audio.ack();
      return { ok: true };
    }

    /* -------------------------------------------------------------- hint */
    hint() {
      if (!this.options.hints || !this.state || this._finished) return null;
      const me = this._humanIndex();
      if (this.state.turn !== me || this.state.phase !== 'active') return null;
      const move = AI.chooseMove(this.state, me, 'hard', null);
      if (!move) return null;
      if (this.audio) this.audio.hint();
      let text;
      if (move.type === 'play') {
        const t = R.tileOf(this.state, move.tileId);
        text = 'Try ' + t.a + '|' + t.b + ' on the ' + (this.state.chain.length ? move.end : 'table') + '.';
      } else text = move.type === 'draw' ? 'Draw from the boneyard.' : 'Pass.';
      this._announce('Hint: ' + text);
      if (this.onEvent) this.onEvent('hint', move);
      return move;
    }

    /* ---------------------------------------------------------- tutorial */
    _tutorialStep() { return this._tutorial ? this._tutorial.def.steps[this._tutorial.stepIdx] : null; }

    _tutorialAllows(cmd) {
      const step = this._tutorialStep();
      if (!step) return true;
      const w = step.expect;
      if (w.type === 'opponent' || w.type === 'opponent-pass') return false; // waiting on guide
      if (cmd.type !== w.type) return false;
      if (w.tileId !== undefined && cmd.tileId !== w.tileId) return false;
      if (w.end !== undefined && cmd.end !== w.end) return false;
      return true;
    }

    _advanceTutorial(ev) {
      if (!this._tutorial) return;
      const step = this._tutorialStep();
      if (!step) return;
      const w = step.expect;
      let match = false;
      if ((w.type === 'opponent' || w.type === 'opponent-pass') && ev.player !== this._humanIndex()) {
        match = w.type === 'opponent' ? ev.type === 'play' : ev.type === 'pass';
      } else if (ev.player === this._humanIndex() && ev.type === w.type) {
        match = (w.tileId === undefined || ev.tileId === w.tileId) &&
                (w.end === undefined || ev.end === w.end);
      }
      if (match) {
        this._tutorial.stepIdx += 1;
        P.telemetry.event('tutorial-step', { id: this._tutorial.def.id, step: this._tutorial.stepIdx });
        if (this._tutorial.stepIdx >= this._tutorial.def.steps.length) {
          const def = this._tutorial.def;
          this._tutorial = null;
          if (this.store && !this.store.progress.tutorials.includes(def.id)) {
            this.store.progress.tutorials.push(def.id);
            if (C.TUTORIALS.every(t => this.store.progress.tutorials.includes(t.id))) {
              const u = P.unlock(this.store, 'mechanic_mastery');
              if (u && this.onEvent) setTimeout(() => this.onEvent('achievement', u), 600);
            }
            this.store.saveNow();
          }
          if (this.onEvent) this.onEvent('tutorial-complete', def);
        } else {
          this._emitTutorialStep();
        }
      }
    }

    _emitTutorialStep() {
      if (!this._tutorial) return;
      const step = this._tutorialStep();
      if (step && this.onEvent) {
        this.onEvent('tutorial', {
          index: this._tutorial.stepIdx, total: this._tutorial.def.steps.length,
          text: step.text, highlight: step.highlight || null, expect: step.expect,
          lessonTitle: this._tutorial.def.title,
        });
        this._announce('Lesson: ' + step.text);
      }
    }

    /* ------------------------------------------------------- view / pause */
    pause() {
      this.paused = true;
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      if (this.renderer) this.renderer.pause();
    }
    resume() {
      this.paused = false;
      if (this.renderer) this.renderer.resume();
      this._maybeRunAI();
      this._emitView();
    }

    leave() {
      this._stopClock();
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      this._finished = true;
    }

    buildView() {
      const st = this.state;
      if (!st) return null;
      const me = Math.max(0, this._humanIndex());
      const myHand = st.hands[me] ? st.hands[me].slice() : [];
      const tileFaces = {};
      const set = R.tileSet(st.ruleset.maxPip);
      myHand.forEach(id => { tileFaces[id] = [set[id].a, set[id].b]; });
      st.chain.forEach(c => { tileFaces[c.id] = [set[c.id].a, set[c.id].b]; });

      const opponentSlots = [
        [{ x: 0, z: -20, rotY: Math.PI }],
        [{ x: -20, z: -4, rotY: Math.PI / 2 }, { x: 20, z: -4, rotY: -Math.PI / 2 }],
        [{ x: -20, z: -4, rotY: Math.PI / 2 }, { x: 0, z: -20, rotY: Math.PI }, { x: 20, z: -4, rotY: -Math.PI / 2 }],
      ];
      const opponents = st.players.map((p, i) => ({ p, i })).filter(x => x.i !== me)
        .map(x => ({ name: x.p.name, count: st.hands[x.i].length, score: x.p.score, isTurn: st.turn === x.i, kind: x.p.kind }));
      const oppPos = opponentSlots[Math.max(0, opponents.length - 1)];

      const myTurn = st.phase === 'active' && st.turn === me;
      const sel = this.selectedTile;
      const legalEnds = (myTurn && sel !== null && myHand.includes(sel))
        ? R.playableEnds(st, sel) : [];
      const actions = myTurn ? R.legalActions(st, me) : [];
      const canDraw = actions.some(a => a.type === 'draw');
      const canPass = actions.some(a => a.type === 'pass');
      const playableTiles = {};
      actions.forEach(a => { if (a.type === 'play') {
        playableTiles[a.tileId] = playableTiles[a.tileId] || [];
        playableTiles[a.tileId].push(a.end);
      } });

      return {
        chain: st.chain.map(c => ({ id: c.id, a: set[c.id].a, b: set[c.id].b, double: set[c.id].double, left: c.left, right: c.right })),
        leftEnd: st.leftEnd, rightEnd: st.rightEnd,
        boneyardCount: st.boneyard.length,
        myHand, tileFaces,
        opponents, opponentPositions: oppPos,
        players: st.players.map((p, i) => ({
          name: p.name, score: p.score, isTurn: st.turn === i, isMe: i === me,
          handCount: st.hands[i].length, plays: p.plays,
        })),
        myTurn, legalEnds, selectedPlayable: legalEnds.length > 0,
        selectedTile: sel,
        playableTiles, canDraw, canPass,
        phase: st.phase, round: st.round, tick: st.tick,
        targetScore: st.ruleset.targetScore,
        turnName: st.players[st.turn] ? st.players[st.turn].name : '',
        ruleset: st.ruleset,
        elapsedMs: this._elapsedMs,
        tutorial: this._tutorial ? {
          text: this._tutorialStep() ? this._tutorialStep().text : '',
          highlight: this._tutorialStep() ? this._tutorialStep().highlight : null,
          index: this._tutorial.stepIdx, total: this._tutorial.def.steps.length,
        } : null,
      };
    }

    _emitView(instant) {
      const view = this.buildView();
      if (this.renderer && view) {
        this.renderer.syncState(view, !!instant || (this.store && this.store.settings.reducedMotion));
        this.renderer.setSelected(view.selectedTile !== null ? String(view.selectedTile) : null);
      }
      if (this.onView) this.onView(view);
    }

    selectTile(tileId) {
      if (!this.state) return;
      const me = this._humanIndex();
      if (this.state.hands[me].indexOf(tileId) < 0) { this.selectedTile = null; }
      else this.selectedTile = (this.selectedTile === tileId) ? null : tileId;
      if (this.audio && this.selectedTile !== null) this.audio.select();
      this._emitView();
    }

    _announce(text, kind) {
      if (this.onAnnounce) this.onAnnounce(text, kind || 'status');
    }
  }

  return { Session, BUILD_VERSION };
});
