/* Chain Dominoes — authoritative Game Script for hosted sessions.
 * Sandboxed, dependency-free apart from the shared rules engine (loaded
 * from js/rules.js in Node, or provided as a global by the host packager).
 *
 * Contract (Games API style):
 *   createSession({ sessionId, seed, players, ruleset, turnDeadlineMs })
 *   submitCommand(sessionId, playerId, commandId, cmd)  // idempotent
 *   getSnapshot(sessionId, playerId)                    // reconnect truth
 *   tick(sessionId, nowMs)                              // deadlines
 *   endSession(sessionId, reason)                       // result contract
 *
 * Security: every command is validated for identity, session membership,
 * turn order, bounds, payload shape, and rules legality. Clients are
 * untrusted: the server owns the deal, the clock, and the result.
 * Hidden information: public views never expose other players' hands.
 */
(function (root, factory) {
  let R;
  if (typeof module === 'object' && module.exports) R = require('./js/rules.js');
  else R = root.ChainDominoesRules;
  const api = factory(R);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesServer = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {
  'use strict';

  const SCRIPT_VERSION = 1;
  const sessions = new Map();

  function publicView(session, forPlayer) {
    const st = session.state;
    return {
      sessionId: session.id,
      scriptVersion: SCRIPT_VERSION,
      phase: st.phase,
      round: st.round,
      tick: st.tick,
      turn: st.turn,
      turnPlayerId: st.players[st.turn] ? st.players[st.turn].id : null,
      leftEnd: st.leftEnd,
      rightEnd: st.rightEnd,
      chain: st.chain.map(c => ({ id: c.id, left: c.left, right: c.right })),
      boneyardCount: st.boneyard.length,
      players: st.players.map((p, i) => ({
        id: p.id, name: p.name, score: p.score,
        handCount: st.hands[i].length,
        connected: session.connected.has(p.id),
      })),
      // hidden information: only the requester's hand is included
      yourHand: typeof forPlayer === 'number' ? st.hands[forPlayer].slice() : null,
      yourIndex: typeof forPlayer === 'number' ? forPlayer : null,
      legalActions: typeof forPlayer === 'number' ? R.legalActions(st, forPlayer) : [],
      roundResult: st.roundResult,
      terminal: st.terminal,
      deadlineAt: session.deadlineAt,
      serverTime: Date.now(),
    };
  }

  function createSession(cfg) {
    if (!cfg || !cfg.sessionId || !Array.isArray(cfg.players)) throw new Error('malformed-session-config');
    if (cfg.players.length < 2 || cfg.players.length > 4) throw new Error('bad-player-count');
    const state = R.createMatch({
      seed: String(cfg.seed || cfg.sessionId),
      ruleset: cfg.ruleset || {},
      players: cfg.players.map(p => ({ id: String(p.id), name: String(p.name || p.id), kind: 'human' })),
    });
    const session = {
      id: String(cfg.sessionId),
      state,
      createdAt: Date.now(),
      turnDeadlineMs: Math.max(5000, cfg.turnDeadlineMs || 45000),
      deadlineAt: Date.now() + (cfg.turnDeadlineMs || 45000),
      connected: new Set(cfg.players.map(p => String(p.id))),
      seenCommands: new Set(),
      log: [],
      ended: null,
    };
    sessions.set(session.id, session);
    return { ok: true, sessionId: session.id, initialHash: R.stateHash(state) };
  }

  function playerIndex(session, playerId) {
    return session.state.players.findIndex(p => p.id === String(playerId));
  }

  function submitCommand(sessionId, playerId, commandId, cmd) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, reason: 'no-such-session' };
    if (session.ended) return { ok: false, reason: 'session-ended' };
    const idx = playerIndex(session, playerId);
    if (idx < 0) return { ok: false, reason: 'not-a-member' };
    if (!session.connected.has(String(playerId))) return { ok: false, reason: 'not-connected' };
    if (!commandId || typeof commandId !== 'string' || commandId.length > 64)
      return { ok: false, reason: 'bad-command-id' };
    if (session.seenCommands.has(commandId)) return { ok: true, duplicate: true }; // idempotent
    if (cmd && typeof cmd === 'object' && JSON.stringify(cmd).length > 512)
      return { ok: false, reason: 'payload-too-large' };

    if (cmd && cmd.type === 'next-round') {
      const r = R.nextRound(session.state);
      if (!r.ok) return { ok: false, reason: r.reason };
      session.seenCommands.add(commandId);
      session.deadlineAt = Date.now() + session.turnDeadlineMs;
      return { ok: true, publicState: publicView(session, idx) };
    }

    const res = R.applyCommand(session.state, idx, cmd);
    if (!res.ok) return { ok: false, reason: res.reason };
    session.seenCommands.add(commandId);
    session.log.push({ tick: session.state.tick, player: idx, cmd, at: Date.now() });
    session.deadlineAt = Date.now() + session.turnDeadlineMs;
    if (session.state.phase === 'match-over') {
      session.ended = { reason: 'completed', terminal: session.state.terminal, at: Date.now() };
    }
    return {
      ok: true, event: res.event,
      publicState: publicView(session, idx),
      stateHash: R.stateHash(session.state),
    };
  }

  // Reconnect source of truth (REST session detail equivalent).
  function getSnapshot(sessionId, playerId) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, reason: 'no-such-session' };
    const idx = playerIndex(session, playerId);
    if (idx < 0) return { ok: false, reason: 'not-a-member' };
    return { ok: true, publicState: publicView(session, idx), ended: session.ended };
  }

  function markConnected(sessionId, playerId, connected) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false };
    const idx = playerIndex(session, playerId);
    if (idx < 0) return { ok: false, reason: 'not-a-member' };
    if (connected) session.connected.add(String(playerId));
    else session.connected.delete(String(playerId));
    return { ok: true };
  }

  // Deadline enforcement: a player who lets the clock lapse forfeits.
  function tick(sessionId, nowMs) {
    const session = sessions.get(String(sessionId));
    if (!session || session.ended) return null;
    const now = nowMs || Date.now();
    if (now < session.deadlineAt) return null;
    if (session.state.phase !== 'active') { session.deadlineAt = now + session.turnDeadlineMs; return null; }
    const st = session.state;
    const offender = st.turn;
    st.phase = 'match-over';
    st.terminal = {
      reason: 'timeout-forfeit',
      winner: (offender + 1) % st.players.length,
      ranking: R.rankPlayers(st),
      scores: st.players.map(p => p.score),
      rounds: st.round, ticks: st.tick, tied: false,
    };
    session.ended = { reason: 'timeout', terminal: st.terminal, at: now };
    return { sessionId: session.id, ended: session.ended };
  }

  function endSession(sessionId, reason) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, reason: 'no-such-session' };
    if (!session.ended) {
      const st = session.state;
      session.ended = {
        reason: reason || 'abandoned',
        terminal: st.terminal || {
          reason: 'abandoned', winner: -1, ranking: R.rankPlayers(st),
          scores: st.players.map(p => p.score), rounds: st.round, ticks: st.tick, tied: false,
        },
        at: Date.now(),
      };
    }
    // Authoritative result contract.
    return { ok: true, result: session.ended };
  }

  // Replay access: full ordered command log + terminal + hashes.
  function getReplay(sessionId) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, reason: 'no-such-session' };
    return {
      ok: true,
      replay: {
        scriptVersion: SCRIPT_VERSION,
        sessionId: session.id,
        commands: session.log.slice(),
        terminal: session.state.terminal,
        finalHash: R.stateHash(session.state),
      },
    };
  }

  function _reset() { sessions.clear(); } // test hook

  return { createSession, submitCommand, getSnapshot, markConnected, tick, endSession, getReplay, _reset, SCRIPT_VERSION };
});
