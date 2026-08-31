/* Chain Dominoes — rules engine (pure, deterministic, no DOM).
 * Works in Node (module.exports) and the browser (window.ChainDominoesRules).
 * Contains its own seeded RNG so this file can be reused verbatim by server.js.
 *
 * State is a plain JSON-serializable object. All transitions go through
 * applyCommand(); no other code may mutate rules state.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesRules = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const STATE_VERSION = 1;

  /* ---------------------------------------------------------------- RNG */
  // FNV-1a string hash -> uint32 (stable across platforms)
  function hashString(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32 — small, fast, deterministic
  function mulberry32(seed) {
    let a = seed >>> 0;
    const next = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int(n) { return Math.floor(next() * n); },               // 0..n-1
      pick(arr) { return arr[Math.floor(next() * arr.length)]; },
      state() { return a >>> 0; },
      setState(s) { a = s >>> 0; },
    };
  }

  // Named, independent streams derived from one master seed.
  function makeStreams(seed) {
    const master = String(seed);
    return {
      rules: mulberry32(hashString(master + ':rules')),
      decor: mulberry32(hashString(master + ':decor')),
      av: mulberry32(hashString(master + ':av')),
    };
  }

  /* --------------------------------------------------------------- Tiles */
  // Double-six set: 28 tiles, id encodes (a,b) with a <= b.
  function buildSet(maxPip) {
    const tiles = [];
    for (let a = 0; a <= maxPip; a++)
      for (let b = a; b <= maxPip; b++)
        tiles.push({ id: tiles.length, a, b, pips: a + b, double: a === b });
    return tiles;
  }

  const SETS = {};
  function tileSet(maxPip) {
    if (!SETS[maxPip]) SETS[maxPip] = buildSet(maxPip);
    return SETS[maxPip];
  }

  /* ------------------------------------------------------------- Ruleset */
  const DEFAULT_RULESET = {
    maxPip: 6,
    targetScore: 100,       // match target; 0 = single round
    maxRounds: 12,          // safety cap on rounds per match
    drawRule: 'until-playable', // 'until-playable' | 'one' | 'none'
    moveLimit: 0,           // per-player total plays; 0 = unlimited
    spinners: false,        // doubles playable on all sides (not used in v1 chain layout)
  };

  function normalizeRuleset(over) {
    return Object.assign({}, DEFAULT_RULESET, over || {});
  }

  /* ---------------------------------------------------------- State init */
  // players: [{ id, name, kind:'human'|'ai', difficulty? }]
  function createMatch(cfg) {
    const ruleset = normalizeRuleset(cfg.ruleset);
    const players = cfg.players.map((p, i) => ({
      id: p.id || ('p' + i),
      name: p.name || ('Player ' + (i + 1)),
      kind: p.kind || 'ai',
      difficulty: p.difficulty || 'medium',
      score: 0,
      invalidActions: 0,
      draws: 0,
      passes: 0,
      plays: 0,
    }));
    const state = {
      version: STATE_VERSION,
      seed: String(cfg.seed),
      ruleset,
      players,
      round: 0,
      tick: 0,               // monotonically increasing command counter
      phase: 'active',       // 'active' | 'round-over' | 'match-over'
      turn: 0,
      chain: [],             // [{id, left, right}] oriented, left->right
      leftEnd: null,
      rightEnd: null,
      hands: players.map(() => []),
      boneyard: [],
      passesInRow: 0,
      lastAction: null,
      terminal: null,        // match terminal record
      roundResult: null,     // last round result (breakdown)
      rng: null,             // rules-stream cursor (uint32)
      log: [],               // ordered applied commands (replay envelope core)
    };
    startRound(state, mulberry32(hashString(String(cfg.seed) + ':rules')));
    return state;
  }

  function startRound(state, rng) {
    const set = tileSet(state.ruleset.maxPip);
    const ids = set.map(t => t.id);
    // Fisher-Yates with rules stream
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }
    const n = state.players.length;
    const handSize = n === 2 ? 7 : 5;
    state.hands = playersDeal(ids, n, handSize);
    state.boneyard = ids.slice(n * handSize);
    state.chain = [];
    state.leftEnd = null;
    state.rightEnd = null;
    state.passesInRow = 0;
    state.roundResult = null;
    state.round += 1;
    state.turn = openingPlayer(state);
    state.phase = 'active';
    state.rng = rng.state();
    state.lastAction = { type: 'round-start', round: state.round, opener: state.turn };
  }

  function playersDeal(ids, n, handSize) {
    const hands = [];
    for (let p = 0; p < n; p++) hands.push(ids.slice(p * handSize, (p + 1) * handSize));
    return hands;
  }

  // Highest double leads; if no double was dealt, highest pip tile leads.
  function openingPlayer(state) {
    let best = -1, bestDouble = -1, bestPips = -1;
    state.hands.forEach((hand, p) => {
      hand.forEach(id => {
        const t = tileSet(state.ruleset.maxPip)[id];
        if (t.double && t.a > bestDouble) { bestDouble = t.a; best = p; }
      });
    });
    if (best >= 0) return best;
    state.hands.forEach((hand, p) => {
      hand.forEach(id => {
        const t = tileSet(state.ruleset.maxPip)[id];
        if (t.pips > bestPips) { bestPips = t.pips; best = p; }
      });
    });
    return Math.max(0, best);
  }

  /* ----------------------------------------------------- Custom setups */
  // Used by tutorials and authored content: explicit hands/chain/turn.
  // Still routed through the same legality/scoring code afterwards.
  function createCustomState(cfg) {
    const state = createMatch({ seed: cfg.seed || 'custom', ruleset: cfg.ruleset, players: cfg.players });
    if (cfg.hands) state.hands = cfg.hands.map(h => h.slice());
    state.boneyard = (cfg.boneyard || []).slice();
    state.chain = [];
    if (cfg.chain && cfg.chain.length) {
      cfg.chain.forEach(c => state.chain.push({ id: c.id, left: c.left, right: c.right }));
      state.leftEnd = state.chain[0].left;
      state.rightEnd = state.chain[state.chain.length - 1].right;
    } else {
      state.leftEnd = null; state.rightEnd = null;
    }
    if (typeof cfg.turn === 'number') state.turn = cfg.turn;
    state.log = [];
    return state;
  }

  /* ----------------------------------------------------------- Legality */
  function tileOf(state, id) { return tileSet(state.ruleset.maxPip)[id]; }

  // A tile can be played on an end if one of its faces matches the open value.
  function playableEnds(state, tileId) {
    const t = tileOf(state, tileId);
    if (state.chain.length === 0) return ['right']; // opener: any tile starts the chain
    const ends = [];
    if (t.a === state.leftEnd || t.b === state.leftEnd) ends.push('left');
    if (t.a === state.rightEnd || t.b === state.rightEnd) ends.push('right');
    return ends;
  }

  // Full legal-action list for a player. Tutorials/hints/AI all call this.
  function legalActions(state, playerIndex) {
    if (!state || state.phase !== 'active') return [];
    if (playerIndex !== state.turn) return [];
    const hand = state.hands[playerIndex];
    const actions = [];
    let hasPlay = false;
    const atLimit = state.ruleset.moveLimit > 0 &&
      state.players[playerIndex].plays >= state.ruleset.moveLimit;
    if (!atLimit) hand.forEach(id => {
      playableEnds(state, id).forEach(end => {
        hasPlay = true;
        actions.push({ type: 'play', tileId: id, end });
      });
    });
    if (!hasPlay) {
      const drewOnce = state.ruleset.drawRule === 'one' && state.lastAction &&
        state.lastAction.type === 'draw' && state.lastAction.player === playerIndex;
      if (state.boneyard.length > 0 && state.ruleset.drawRule !== 'none' && !drewOnce) {
        actions.push({ type: 'draw' });
      } else {
        actions.push({ type: 'pass' });
      }
    }
    return actions;
  }

  // Why is this command not legal? Stable machine-readable reason codes.
  function invalidReason(state, playerIndex, cmd) {
    if (!state) return 'no-state';
    if (state.phase === 'match-over') return 'game-over';
    if (state.phase === 'round-over') return 'round-over';
    if (playerIndex !== state.turn) return 'not-your-turn';
    if (!cmd || typeof cmd.type !== 'string') return 'malformed-command';
    if (cmd.type === 'play') {
      const hand = state.hands[playerIndex];
      if (typeof cmd.tileId !== 'number' || hand.indexOf(cmd.tileId) < 0) return 'tile-not-in-hand';
      if (cmd.end !== 'left' && cmd.end !== 'right') return 'bad-end';
      if (playableEnds(state, cmd.tileId).indexOf(cmd.end) < 0) return 'no-matching-end';
      if (state.ruleset.moveLimit > 0 && state.players[playerIndex].plays >= state.ruleset.moveLimit)
        return 'move-limit-reached';
      return null;
    }
    if (cmd.type === 'draw') {
      const canPlay = state.hands[playerIndex].some(id => playableEnds(state, id).length > 0);
      const atLimit = state.ruleset.moveLimit > 0 &&
        state.players[playerIndex].plays >= state.ruleset.moveLimit;
      if (canPlay && !atLimit) return 'must-play-if-able';
      if (state.boneyard.length === 0) return 'boneyard-empty';
      if (state.ruleset.drawRule === 'none') return 'draw-disabled';
      if (state.ruleset.drawRule === 'one' && state.lastAction &&
          state.lastAction.type === 'draw' && state.lastAction.player === playerIndex)
        return 'draw-limit-one';
      return null;
    }
    if (cmd.type === 'pass') {
      const canPlay = state.hands[playerIndex].some(id => playableEnds(state, id).length > 0);
      const atLimit = state.ruleset.moveLimit > 0 &&
        state.players[playerIndex].plays >= state.ruleset.moveLimit;
      if (canPlay && !atLimit) return 'must-play-if-able';
      const drewOnce = state.ruleset.drawRule === 'one' && state.lastAction &&
        state.lastAction.type === 'draw' && state.lastAction.player === playerIndex;
      if (state.boneyard.length > 0 && state.ruleset.drawRule !== 'none' && !drewOnce) return 'must-draw-first';
      return null;
    }
    return 'unknown-command';
  }

  function isLegal(state, playerIndex, cmd) { return invalidReason(state, playerIndex, cmd) === null; }

  /* ---------------------------------------------------------- Transitions */
  function handPips(state, p) {
    return state.hands[p].reduce((s, id) => s + tileOf(state, id).pips, 0);
  }

  function applyCommand(state, playerIndex, cmd) {
    const reason = invalidReason(state, playerIndex, cmd);
    if (reason) {
      // Count invalid attempts (used by tie-breaks) without changing play state.
      if (state.players[playerIndex]) state.players[playerIndex].invalidActions += 1;
      return { ok: false, reason, state };
    }
    state.tick += 1;
    let event = null;
    if (cmd.type === 'play') event = doPlay(state, playerIndex, cmd);
    else if (cmd.type === 'draw') event = doDraw(state, playerIndex);
    else event = doPass(state, playerIndex);
    state.lastAction = event;
    state.log.push({ tick: state.tick, player: playerIndex, cmd: { type: cmd.type, tileId: cmd.tileId, end: cmd.end } });
    return { ok: true, event, state };
  }

  function doPlay(state, p, cmd) {
    const t = tileOf(state, cmd.tileId);
    state.hands[p].splice(state.hands[p].indexOf(cmd.tileId), 1);
    state.players[p].plays += 1;
    state.passesInRow = 0;
    let placed;
    if (state.chain.length === 0) {
      placed = { id: t.id, left: t.a, right: t.b };
      state.chain.push(placed);
    } else if (cmd.end === 'left') {
      // match state.leftEnd with one face; other face becomes new left end
      const outward = (t.a === state.leftEnd) ? t.b : t.a;
      placed = { id: t.id, left: outward, right: state.leftEnd };
      state.chain.unshift(placed);
    } else {
      const outward = (t.a === state.rightEnd) ? t.b : t.a;
      placed = { id: t.id, left: state.rightEnd, right: outward };
      state.chain.push(placed);
    }
    state.leftEnd = state.chain[0].left;
    state.rightEnd = state.chain[state.chain.length - 1].right;
    const event = { type: 'play', player: p, tileId: t.id, end: cmd.end, leftEnd: state.leftEnd, rightEnd: state.rightEnd, chainLength: state.chain.length };
    if (state.hands[p].length === 0) { endRound(state, 'domino', p); event.roundOver = true; }
    else advanceTurn(state);
    return event;
  }

  function doDraw(state, p) {
    // Reconstruct deterministic draw: boneyard order was fixed at deal time,
    // so drawing from the front is deterministic across replays.
    const id = state.boneyard.shift();
    state.hands[p].push(id);
    state.players[p].draws += 1;
    const t = tileOf(state, id);
    const event = { type: 'draw', player: p, tileId: id, pips: t.pips, boneyardLeft: state.boneyard.length };
    // 'until-playable': player keeps the turn (must draw again or play).
    // 'one': after a single draw, turn advances if still no play... standard
    // casual rule: with 'one', if the drawn tile is playable you may play it,
    // otherwise turn passes. Implement: if still no legal play and boneyard
    // rule is 'one', advance turn automatically as a pass.
    if (state.ruleset.drawRule === 'one') {
      const canPlay = state.hands[p].some(tid => playableEnds(state, tid).length > 0);
      if (!canPlay) { state.players[p].passes += 1; state.passesInRow += 1; event.autoPass = true; checkBlockedOrAdvance(state); }
    }
    if (state.phase !== 'active') event.roundOver = true;
    return event;
  }

  function doPass(state, p) {
    state.players[p].passes += 1;
    state.passesInRow += 1;
    const event = { type: 'pass', player: p, passesInRow: state.passesInRow };
    checkBlockedOrAdvance(state);
    if (state.phase !== 'active') event.roundOver = true;
    return event;
  }

  function checkBlockedOrAdvance(state) {
    if (state.passesInRow >= state.players.length) {
      // Everyone passed in sequence: blocked round.
      endRound(state, 'blocked', null);
    } else {
      advanceTurn(state);
    }
  }

  function advanceTurn(state) {
    state.turn = (state.turn + 1) % state.players.length;
  }

  /* -------------------------------------------------------------- Scoring */
  function endRound(state, reason, dominoWinner) {
    const pipTotals = state.players.map((_, p) => handPips(state, p));
    let winners;
    if (reason === 'domino') {
      winners = [dominoWinner];
    } else {
      const low = Math.min.apply(null, pipTotals);
      winners = pipTotals.map((v, p) => (v === low ? p : -1)).filter(p => p >= 0);
    }
    // Points: winner scores opponents' remaining pips minus own remainder.
    const breakdown = winners.map(w => {
      const others = pipTotals.reduce((s, v, p) => (p === w ? s : s + v), 0);
      const own = reason === 'domino' ? 0 : pipTotals[w];
      return { player: w, fromOpponents: others, ownRemainder: own, points: Math.max(0, others - own) };
    });
    // Co-winners in a blocked round split nothing extra; each gets own margin.
    breakdown.forEach(b => { state.players[b.player].score += b.points; });

    state.roundResult = {
      reason, winners, pipTotals: pipTotals.slice(), breakdown,
      round: state.round,
    };

    const target = state.ruleset.targetScore;
    const someoneReached = target > 0 && state.players.some(pl => pl.score >= target);
    const exhausted = state.round >= state.ruleset.maxRounds;
    const allExhausted = state.ruleset.moveLimit > 0 && state.players.every((pl, p) =>
      pl.plays >= state.ruleset.moveLimit || state.hands[p].length === 0);
    if (someoneReached || exhausted || allExhausted) {
      finishMatch(state, someoneReached ? 'target-reached' : (allExhausted ? 'move-limit' : 'rounds-exhausted'));
    } else {
      state.phase = 'round-over';
    }
  }

  // Tie-break order: objective (score) desc, fewer invalid actions, lower tick
  // count (authoritative elapsed), then stable player id.
  function rankPlayers(state) {
    return state.players.map((pl, p) => ({
      player: p, score: pl.score, invalid: pl.invalidActions,
      ticks: pl.plays + pl.draws + pl.passes, id: pl.id,
    })).sort((a, b) =>
      (b.score - a.score) ||
      (a.invalid - b.invalid) ||
      (a.ticks - b.ticks) ||
      (a.id < b.id ? -1 : 1));
  }

  function finishMatch(state, reason) {
    const ranking = rankPlayers(state);
    state.phase = 'match-over';
    state.terminal = {
      reason,
      ranking,
      winner: ranking[0].player,
      tied: ranking.length > 1 && ranking[0].score === ranking[1].score &&
            ranking[0].invalid === ranking[1].invalid && ranking[0].ticks === ranking[1].ticks,
      scores: state.players.map(pl => pl.score),
      rounds: state.round,
      ticks: state.tick,
    };
  }

  // Next round of the same match (only valid at 'round-over').
  function nextRound(state) {
    if (state.phase !== 'round-over') return { ok: false, reason: 'not-round-over' };
    const rng = mulberry32(state.rng >>> 0);
    startRound(state, rng);
    return { ok: true, state };
  }

  /* ----------------------------------------------------- Serialization */
  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    const s = JSON.parse(json);
    if (s.version !== STATE_VERSION) s.version = STATE_VERSION; // migration point
    return s;
  }

  // Canonical hash for replay verification (FNV-1a over stable key order).
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function stateHash(state) {
    const clone = Object.assign({}, state);
    delete clone.log; // log is derived; hash the meaningful state
    return hashString(stableStringify(clone)).toString(16);
  }

  /* ------------------------------------------------------------- Replay */
  // Re-run a command log from scratch; verify identical terminal hash.
  function replay(cfg, log) {
    const state = createMatch(cfg);
    for (const entry of log) {
      if (entry.cmd.type === 'next-round') { nextRound(state); continue; }
      const r = applyCommand(state, entry.player, entry.cmd);
      if (!r.ok) return { ok: false, reason: 'replay-command-rejected', at: entry.tick };
    }
    return { ok: true, state, hash: stateHash(state) };
  }

  return {
    STATE_VERSION, DEFAULT_RULESET,
    hashString, mulberry32, makeStreams,
    tileSet, tileOf, normalizeRuleset,
    createMatch, createCustomState, nextRound,
    legalActions, invalidReason, isLegal, applyCommand,
    playableEnds, handPips, rankPlayers,
    serialize, deserialize, stateHash, stableStringify, replay,
  };
});
