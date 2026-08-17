/* Chain Dominoes — practice AI. Deterministic: given the same state, rng
 * stream, and difficulty, it always picks the same move. Uses only the public
 * legal-action API plus its own (visible) hand knowledge.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./rules.js') : root.ChainDominoesRules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesAI = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {
  'use strict';

  function tileOf(state, id) { return R.tileOf(state, id); }

  // Score a candidate play. Higher is better.
  function evaluate(state, p, action, difficulty) {
    const t = tileOf(state, action.tileId);
    let score = t.pips; // shed heavy tiles
    const hand = state.hands[p].filter(id => id !== action.tileId);

    // Balance: after playing, prefer keeping tiles that match the ends.
    const endsAfter = simulateEnds(state, action);
    const coverage = new Set();
    hand.forEach(id => {
      const h = tileOf(state, id);
      [h.a, h.b].forEach(v => {
        if (v === endsAfter.left || v === endsAfter.right) coverage.add(v);
      });
    });
    score += coverage.size * 2;

    if (difficulty === 'hard') {
      // Prefer doubles when ahead on board presence (holds an end value).
      if (t.double) score += 1.5;
      // Reduce pip variance: dump outliers.
      const pips = hand.map(id => tileOf(state, id).pips);
      const max = pips.length ? Math.max.apply(null, pips) : 0;
      score += (t.pips >= max - 1) ? 2 : 0;
      // Aggressive: if this empties the hand, huge bonus.
      if (state.hands[p].length === 1) score += 100;
      // End control: if the opponent just passed, keep their missing value open.
      if (state.lastAction && state.lastAction.type === 'pass') {
        score += (endsAfter.left === endsAfter.right) ? 3 : 0;
      }
    }
    return score;
  }

  function simulateEnds(state, action) {
    const t = tileOf(state, action.tileId);
    if (state.chain.length === 0) return { left: t.a, right: t.b };
    if (action.end === 'left') {
      const outward = (t.a === state.leftEnd) ? t.b : t.a;
      return { left: outward, right: state.rightEnd };
    }
    const outward = (t.a === state.rightEnd) ? t.b : t.a;
    return { left: state.leftEnd, right: outward };
  }

  // rng: a mulberry32-compatible stream (session 'ai' stream). May be null
  // for fully deterministic tie-breaking (then uses fixed order).
  function chooseMove(state, playerIndex, difficulty, rng) {
    const acts = R.legalActions(state, playerIndex);
    if (acts.length === 0) return null;
    if (acts.length === 1) return acts[0];
    const nonTrivial = acts.filter(a => a.type === 'play');
    if (difficulty === 'easy' || nonTrivial.length === 0) {
      return acts[rng ? rng.int(acts.length) : 0];
    }
    const scored = nonTrivial.map(a => ({ a, s: evaluate(state, playerIndex, a, difficulty) }));
    scored.sort((x, y) => y.s - x.s || (x.a.tileId - y.a.tileId) || (x.a.end < y.a.end ? -1 : 1));
    if (difficulty === 'medium') {
      // Medium: pick among the top candidates with some seeded variety.
      const top = scored.filter(e => e.s >= scored[0].s - 3);
      return (rng ? top[rng.int(top.length)] : top[0]).a;
    }
    return scored[0].a; // hard: best evaluated move, stable tie-break
  }

  return { chooseMove, evaluate, simulateEnds };
});
