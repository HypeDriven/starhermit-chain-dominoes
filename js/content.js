/* Chain Dominoes — versioned content: tutorials, journey stages, challenges,
 * daily generator, themes. Pure data + small pure functions; no DOM.
 * Content schema: { id, version, seed, kind, ruleset, players, goals, par,
 * tutorialFlags, theme, setup? } — validated offline by test/content.test.js.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../js/rules.js') : root.ChainDominoesRules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesContent = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {
  'use strict';

  const CONTENT_VERSION = 1;

  /* ------------------------------------------------------------- Themes */
  // Five original visual themes. Colors drive both the 3D scene and CSS.
  const THEMES = [
    {
      id: 'ceramic-classic', name: 'Ceramic Classic',
      table: 0x7a5a3a, felt: 0x2e5d4b, tileBody: 0xf4efe4, tileEdge: 0xd9d2c0,
      pip: 0x2b2b30, accent: 0xd98e3a, accent2: 0x4f8f74, wall: 0x8a6f52,
      fog: 0x2a211a, cupColor: 0xb8452e,
      css: { bg: '#241c15', panel: '#2f261d', text: '#f2ead9', accent: '#d98e3a', good: '#6fbf8f', bad: '#e06c5c' },
    },
    {
      id: 'midnight-espresso', name: 'Midnight Espresso', exposure: 1.55, lightBoost: 1.5,
      table: 0x3a2e28, felt: 0x1f3230, tileBody: 0x39424f, tileEdge: 0x1a2028,
      pip: 0xf2ecd8, accent: 0xc9a227, accent2: 0x5b8a8a, wall: 0x2a2230,
      fog: 0x12100e, cupColor: 0xc9a227,
      css: { bg: '#141114', panel: '#1e1a1e', text: '#ece4d2', accent: '#c9a227', good: '#7fc9a9', bad: '#e07a6a' },
    },
    {
      id: 'sage-garden', name: 'Sage Garden',
      table: 0x9a7d55, felt: 0x5e7d5a, tileBody: 0xf7f3e8, tileEdge: 0xd8d2bd,
      pip: 0x33412f, accent: 0x4e7c59, accent2: 0xc98f4a, wall: 0xb5a07e,
      fog: 0x33402e, cupColor: 0xf7f3e8,
      css: { bg: '#1d241a', panel: '#27301f', text: '#f0efe0', accent: '#8fbf7f', good: '#8fbf7f', bad: '#e08a6c' },
    },
    {
      id: 'terracotta-sun', name: 'Terracotta Sun',
      table: 0xa5663f, felt: 0x8a4b32, tileBody: 0xfdf6e9, tileEdge: 0xe3d3b8,
      pip: 0x4a2c1a, accent: 0xe07b39, accent2: 0x3f7d8c, wall: 0xc08a5e,
      fog: 0x3d2417, cupColor: 0x3f7d8c,
      css: { bg: '#2a1710', panel: '#382014', text: '#f7ecd8', accent: '#e07b39', good: '#7fbf9f', bad: '#e05c4c' },
    },
    {
      id: 'mono-ink', name: 'Mono Ink', exposure: 1.2,
      table: 0x4a4a4f, felt: 0x2c2c31, tileBody: 0xececf0, tileEdge: 0xc9c9cf,
      pip: 0x17171c, accent: 0xffffff, accent2: 0x8a8a92, wall: 0x3a3a40,
      fog: 0x101013, cupColor: 0xececf0,
      css: { bg: '#131316', panel: '#1c1c21', text: '#f2f2f5', accent: '#ffffff', good: '#a8d8b8', bad: '#e89a92' },
    },
  ];

  // Color-vision-safe gameplay palette overrides (applied to accents/markers).
  const CVD_PALETTES = {
    none: { good: null, bad: null, p2: null, p3: null },
    protanopia: { good: '#4fa8e0', bad: '#e0b04f', p2: '#c98ae0', p3: '#8ae0c9' },
    deuteranopia: { good: '#4fa8e0', bad: '#e0b04f', p2: '#c98ae0', p3: '#8ae0c9' },
    tritanopia: { good: '#4fd0c9', bad: '#e06c8a', p2: '#e0b04f', p3: '#b0b0e0' },
  };

  /* ----------------------------------------------------------- Tutorials */
  // Interactive lessons: each step requires the player to perform the action.
  // Steps: { text, expect: {type:'play',tileId?,end?} | {type:'draw'} | {type:'pass'},
  //          highlight?: {tileId?|end?} }. All states are crafted, then the
  //          normal rules engine adjudicates — no duplicated rules.
  const T = (a, b) => { // helper: tile id for double-6 set
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return R.tileSet(6).find(t => t.a === lo && t.b === hi).id;
  };

  const TUTORIALS = [
    {
      id: 't1-matching', version: 1, title: 'Match the Ends', kind: 'tutorial', theme: 'ceramic-classic',
      intro: 'Dominoes connect when touching ends show the same number. Play the tile that matches an open end.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(2, 4), left: 2, right: 4 }],
        hands: [[T(4, 6), T(1, 3)], [T(2, 2), T(0, 0)]], boneyard: [], turn: 0,
      },
      steps: [
        { text: 'The open ends are 2 (left) and 4 (right). Your 4|6 tile has a 4 — play it on the RIGHT end.', expect: { type: 'play', tileId: T(4, 6), end: 'right' }, highlight: { tileId: T(4, 6), end: 'right' } },
        { text: 'The guide answers with its double 2|2 on the left end…', expect: { type: 'opponent' } },
        { text: 'The ends are 2 and 6. Your 1|3 matches neither, and the boneyard is empty — so PASS.', expect: { type: 'pass' } },
      ],
      outro: 'That is the whole core rule: match an open end, or draw/pass when you cannot. Next: the boneyard.',
    },
    {
      id: 't2-drawing', version: 1, title: 'The Boneyard', kind: 'tutorial', theme: 'ceramic-classic',
      intro: 'No matching tile? Draw from the boneyard until you can play — or pass when it is empty.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(6, 6), left: 6, right: 6 }],
        hands: [[T(0, 1)], [T(3, 3), T(0, 0)]], boneyard: [T(3, 6), T(0, 5)], turn: 0,
      },
      steps: [
        { text: 'Both ends show 6 and your 0|1 matches neither. DRAW from the boneyard.', expect: { type: 'draw' } },
        { text: 'You drew 3|6 — it has a 6! Play it on either end.', expect: { type: 'play', tileId: T(3, 6) }, highlight: { tileId: T(3, 6) } },
        { text: 'The guide plays its double 3|3. The ends barely change…', expect: { type: 'opponent' } },
        { text: 'Your 0|1 matches neither end. Draw again.', expect: { type: 'draw' } },
        { text: '0|5 still cannot match. The boneyard is empty now, so PASS.', expect: { type: 'pass' } },
      ],
      outro: 'Drawing keeps you in the round; passing is the last resort. Next: doubles.',
    },
    {
      id: 't3-doubles', version: 1, title: 'Doubles Sit Crosswise', kind: 'tutorial', theme: 'sage-garden',
      intro: 'Doubles are placed across the chain. Both faces count as the open value.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(3, 5), left: 3, right: 5 }],
        hands: [[T(5, 5), T(0, 3)], [T(1, 5), T(0, 0)]], boneyard: [], turn: 0,
      },
      steps: [
        { text: 'Play your double 5|5 on the RIGHT end (a 5). See how it sits across the chain?', expect: { type: 'play', tileId: T(5, 5), end: 'right' }, highlight: { tileId: T(5, 5), end: 'right' } },
        { text: 'The right end is still 5. The guide will answer with 1|5…', expect: { type: 'opponent' } },
        { text: 'Now the right end is 1. Finish the lesson: your 0|3 matches the LEFT end (3).', expect: { type: 'play', tileId: T(0, 3), end: 'left' }, highlight: { tileId: T(0, 3), end: 'left' } },
      ],
      outro: 'Doubles keep the same end value — use them to hold a number your opponent cannot match.',
    },
    {
      id: 't4-domino', version: 1, title: 'Going Domino', kind: 'tutorial', theme: 'sage-garden',
      intro: 'Empty your hand and you win the round, scoring every pip left in opposing hands.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(2, 6), left: 2, right: 6 }],
        hands: [[T(4, 6)], [T(5, 6), T(0, 4)]], boneyard: [], turn: 0,
      },
      steps: [
        { text: 'Your last tile, 4|6, matches the RIGHT end. Play it to go DOMINO!', expect: { type: 'play', tileId: T(4, 6), end: 'right' }, highlight: { tileId: T(4, 6), end: 'right' } },
      ],
      outro: 'You scored all 15 pips the guide was holding. Fewer pips in hand means less risk.',
    },
    {
      id: 't5-blocked', version: 1, title: 'Blocked Rounds', kind: 'tutorial', theme: 'terracotta-sun',
      intro: 'When nobody can play and the boneyard is empty, the lowest remaining pip total wins.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(6, 6), left: 6, right: 6 }],
        hands: [[T(0, 1)], [T(2, 5)]], boneyard: [], turn: 0,
      },
      steps: [
        { text: 'Ends are 6 and 6. Your 0|1 (1 pip) cannot play, and the boneyard is empty. PASS.', expect: { type: 'pass' } },
        { text: 'The guide holds 2|5 (7 pips) and also cannot play — the round is BLOCKED.', expect: { type: 'opponent-pass' } },
      ],
      outro: 'Your 1 pip beats the guide\'s 7. Shed heavy tiles early — they are a liability when rounds lock up.',
    },
    {
      id: 't6-strategy', version: 1, title: 'Reading the Table', kind: 'tutorial', theme: 'terracotta-sun',
      intro: 'Keep a balanced hand: holding tiles that match both ends keeps you flexible.',
      setup: {
        ruleset: { targetScore: 0 }, players: [{ id: 'you', name: 'You', kind: 'human' }, { id: 'guide', name: 'Guide', kind: 'ai', difficulty: 'scripted' }],
        chain: [{ id: T(1, 4), left: 1, right: 4 }],
        hands: [[T(1, 1), T(2, 4), T(1, 6)], [T(2, 6), T(0, 0)]], boneyard: [], turn: 0,
      },
      steps: [
        { text: 'Three of your tiles can play. The 2|4 keeps your hand balanced across both ends — play it on the RIGHT.', expect: { type: 'play', tileId: T(2, 4), end: 'right' }, highlight: { tileId: T(2, 4), end: 'right' } },
        { text: 'The guide plays 2|6. Now the ends are 1 and 6…', expect: { type: 'opponent' } },
        { text: 'And you still hold the answer: play 1|6 — it matches BOTH open ends.', expect: { type: 'play', tileId: T(1, 6) }, highlight: { tileId: T(1, 6) } },
      ],
      outro: 'You finished all six lessons. The café tables are open — good luck!',
    },
  ];

  /* ------------------------------------------------------------- Journey */
  // 40 authored stages. Difficulty grows via opponents, AI skill, target
  // score, and constraints — one new concept at a time, mastery every 8th.
  const AI_NAMES = ['Marta', 'Theo', 'Ines', 'Kofi', 'Sana', 'Piotr', 'Lena', 'Rui'];

  function stageDef(n, o) {
    return Object.assign({
      id: 'j' + n, version: CONTENT_VERSION, kind: 'journey', number: n,
      seed: 'journey-' + n, tutorialFlags: [], mastery: false,
    }, o);
  }

  const JOURNEY = [
    stageDef(1, { name: 'First Table', players: 2, ai: ['easy'], targetScore: 30, theme: 'ceramic-classic', par: { rounds: 6 }, tutorialFlags: ['matching'], blurb: 'A quiet corner table. Beat Marta to 30 points.' }),
    stageDef(2, { name: 'Open Ends', players: 2, ai: ['easy'], targetScore: 40, theme: 'ceramic-classic', par: { rounds: 6 }, tutorialFlags: ['ends'] }),
    stageDef(3, { name: 'Deep Boneyard', players: 2, ai: ['easy'], targetScore: 40, theme: 'ceramic-classic', par: { rounds: 6 }, tutorialFlags: ['drawing'] }),
    stageDef(4, { name: 'Crosswise', players: 2, ai: ['easy'], targetScore: 50, theme: 'sage-garden', par: { rounds: 6 }, tutorialFlags: ['doubles'] }),
    stageDef(5, { name: 'Light Hand', players: 2, ai: ['easy'], targetScore: 50, theme: 'sage-garden', par: { rounds: 5 }, tutorialFlags: ['pips'] }),
    stageDef(6, { name: 'Steady Pour', players: 2, ai: ['medium'], targetScore: 50, theme: 'sage-garden', par: { rounds: 5 } }),
    stageDef(7, { name: 'Narrow Window', players: 2, ai: ['medium'], targetScore: 50, theme: 'sage-garden', par: { rounds: 5 }, drawRule: 'one', tutorialFlags: ['draw-one'] }),
    stageDef(8, { name: 'Mastery: The Regular', players: 2, ai: ['medium'], targetScore: 60, theme: 'ceramic-classic', par: { rounds: 5 }, mastery: true, blurb: 'Prove the basics against a sharper opponent.' }),
    stageDef(9, { name: 'Third Chair', players: 3, ai: ['easy', 'easy'], targetScore: 50, theme: 'terracotta-sun', par: { rounds: 6 }, tutorialFlags: ['multiplayer'] }),
    stageDef(10, { name: 'Busy Lunch', players: 3, ai: ['easy', 'medium'], targetScore: 60, theme: 'terracotta-sun', par: { rounds: 6 } }),
    stageDef(11, { name: 'Short Supply', players: 3, ai: ['medium', 'medium'], targetScore: 60, theme: 'terracotta-sun', par: { rounds: 6 }, drawRule: 'one' }),
    stageDef(12, { name: 'Closing Time', players: 2, ai: ['medium'], targetScore: 60, theme: 'midnight-espresso', par: { rounds: 5 }, maxRounds: 6, tutorialFlags: ['max-rounds'] }),
    stageDef(13, { name: 'Heavy Lids', players: 2, ai: ['medium'], targetScore: 60, theme: 'midnight-espresso', par: { rounds: 5 }, drawRule: 'none', tutorialFlags: ['no-draw'] }),
    stageDef(14, { name: 'Corner Booth', players: 3, ai: ['medium', 'medium'], targetScore: 70, theme: 'midnight-espresso', par: { rounds: 6 } }),
    stageDef(15, { name: 'Full House', players: 4, ai: ['easy', 'easy', 'medium'], targetScore: 70, theme: 'terracotta-sun', par: { rounds: 6 }, tutorialFlags: ['four-player'] }),
    stageDef(16, { name: 'Mastery: Café Circuit', players: 3, ai: ['medium', 'medium'], targetScore: 80, theme: 'ceramic-classic', par: { rounds: 5 }, mastery: true }),
    stageDef(17, { name: 'Espresso Shot', players: 2, ai: ['medium'], targetScore: 40, theme: 'midnight-espresso', par: { rounds: 3 }, maxRounds: 4, blurb: 'Short and sharp — every round counts.' }),
    stageDef(18, { name: 'Reserved Sign', players: 4, ai: ['medium', 'easy', 'medium'], targetScore: 70, theme: 'sage-garden', par: { rounds: 6 } }),
    stageDef(19, { name: 'Last Carafe', players: 3, ai: ['medium', 'medium'], targetScore: 70, theme: 'sage-garden', par: { rounds: 5 }, drawRule: 'one' }),
    stageDef(20, { name: 'Silent Counter', players: 2, ai: ['hard'], targetScore: 60, theme: 'mono-ink', par: { rounds: 5 }, tutorialFlags: ['hard-ai'] }),
    stageDef(21, { name: 'Twin Grinders', players: 4, ai: ['medium', 'medium', 'easy'], targetScore: 80, theme: 'terracotta-sun', par: { rounds: 6 } }),
    stageDef(22, { name: 'No Refills', players: 3, ai: ['medium', 'hard'], targetScore: 70, theme: 'midnight-espresso', par: { rounds: 5 }, drawRule: 'none' }),
    stageDef(23, { name: 'Slow Sunday', players: 2, ai: ['hard'], targetScore: 80, theme: 'sage-garden', par: { rounds: 5 } }),
    stageDef(24, { name: 'Mastery: House Blend', players: 4, ai: ['medium', 'medium', 'medium'], targetScore: 90, theme: 'terracotta-sun', par: { rounds: 6 }, mastery: true }),
    stageDef(25, { name: 'Checkerboard', players: 2, ai: ['hard'], targetScore: 70, theme: 'mono-ink', par: { rounds: 5 }, drawRule: 'one' }),
    stageDef(26, { name: 'Rush Hour', players: 4, ai: ['medium', 'hard', 'medium'], targetScore: 90, theme: 'terracotta-sun', par: { rounds: 6 } }),
    stageDef(27, { name: 'Quiet Regulars', players: 3, ai: ['hard', 'medium'], targetScore: 80, theme: 'ceramic-classic', par: { rounds: 5 } }),
    stageDef(28, { name: 'Steam & Static', players: 2, ai: ['hard'], targetScore: 80, theme: 'midnight-espresso', par: { rounds: 4 }, maxRounds: 5 }),
    stageDef(29, { name: 'Tight Margins', players: 3, ai: ['hard', 'hard'], targetScore: 80, theme: 'mono-ink', par: { rounds: 5 }, drawRule: 'one' }),
    stageDef(30, { name: 'Long Afternoon', players: 2, ai: ['hard'], targetScore: 100, theme: 'sage-garden', par: { rounds: 6 } }),
    stageDef(31, { name: 'Four Cups Empty', players: 4, ai: ['hard', 'medium', 'hard'], targetScore: 100, theme: 'terracotta-sun', par: { rounds: 6 } }),
    stageDef(32, { name: 'Mastery: Barista\'s Table', players: 3, ai: ['hard', 'hard'], targetScore: 100, theme: 'midnight-espresso', par: { rounds: 5 }, mastery: true, drawRule: 'one' }),
    stageDef(33, { name: 'Ink & Porcelain', players: 2, ai: ['hard'], targetScore: 90, theme: 'mono-ink', par: { rounds: 4 }, drawRule: 'none' }),
    stageDef(34, { name: 'Terrace Season', players: 4, ai: ['hard', 'hard', 'medium'], targetScore: 100, theme: 'sage-garden', par: { rounds: 6 } }),
    stageDef(35, { name: 'Last Train', players: 3, ai: ['hard', 'hard'], targetScore: 90, theme: 'midnight-espresso', par: { rounds: 4 }, maxRounds: 5 }),
    stageDef(36, { name: 'Full Roast', players: 4, ai: ['hard', 'hard', 'medium'], targetScore: 110, theme: 'terracotta-sun', par: { rounds: 6 }, drawRule: 'one' }),
    stageDef(37, { name: 'House Reserve', players: 2, ai: ['hard'], targetScore: 100, theme: 'mono-ink', par: { rounds: 4 }, drawRule: 'none', maxRounds: 6 }),
    stageDef(38, { name: 'Closing Shift', players: 3, ai: ['hard', 'hard'], targetScore: 110, theme: 'midnight-espresso', par: { rounds: 5 } }),
    stageDef(39, { name: 'The Long Game', players: 4, ai: ['hard', 'hard', 'hard'], targetScore: 120, theme: 'ceramic-classic', par: { rounds: 6 } }),
    stageDef(40, { name: 'Mastery: Café Champion', players: 4, ai: ['hard', 'hard', 'hard'], targetScore: 150, theme: 'midnight-espresso', par: { rounds: 6 }, mastery: true, drawRule: 'one', blurb: 'The toughest table in the house. Take the title.' }),
  ];

  function stageToConfig(stage, playerName) {
    const players = [{ id: 'you', name: playerName || 'You', kind: 'human' }];
    for (let i = 1; i < stage.players; i++) {
      players.push({ id: 'ai' + i, name: AI_NAMES[(stage.number + i * 3) % AI_NAMES.length], kind: 'ai', difficulty: stage.ai[i - 1] || 'medium' });
    }
    return {
      seed: stage.seed,
      ruleset: {
        targetScore: stage.targetScore,
        maxRounds: stage.maxRounds || 12,
        drawRule: stage.drawRule || 'until-playable',
        moveLimit: stage.moveLimit || 0,
      },
      players,
    };
  }

  /* ---------------------------------------------------------- Challenges */
  const CHALLENGES = [
    { id: 'c-speed-60', version: 1, kind: 'challenge', name: 'Speed Roast', seed: 'chal-speed-60', theme: 'midnight-espresso',
      goal: 'Reach 60 points in under 4 minutes.', timeLimitSec: 240, players: 2, ai: ['medium'], ruleset: { targetScore: 60 } },
    { id: 'c-frugal', version: 1, kind: 'challenge', name: 'Frugal Fingers', seed: 'chal-frugal', theme: 'sage-garden',
      goal: 'Win a 60-point match playing at most 22 tiles.', moveLimit: 22, players: 2, ai: ['medium'], ruleset: { targetScore: 60, moveLimit: 22 } },
    { id: 'c-dry', version: 1, kind: 'challenge', name: 'Dry Counter', seed: 'chal-dry', theme: 'mono-ink',
      goal: 'Win to 50 with the boneyard closed.', players: 2, ai: ['medium'], ruleset: { targetScore: 50, drawRule: 'none' } },
    { id: 'c-solo-crowd', version: 1, kind: 'challenge', name: 'Outnumbered', seed: 'chal-crowd', theme: 'terracotta-sun',
      goal: 'Beat three hard opponents racing to 90.', players: 4, ai: ['hard', 'hard', 'hard'], ruleset: { targetScore: 90 } },
    { id: 'c-one-sip', version: 1, kind: 'challenge', name: 'One Sip', seed: 'chal-onesip', theme: 'ceramic-classic',
      goal: 'Win to 40 drawing at most one tile per turn.', players: 2, ai: ['hard'], ruleset: { targetScore: 40, drawRule: 'one' } },
    { id: 'c-marathon', version: 1, kind: 'challenge', name: 'Bottomless Cup', seed: 'chal-marathon', theme: 'sage-garden',
      goal: 'Outlast two hard opponents to 150.', players: 3, ai: ['hard', 'hard'], ruleset: { targetScore: 150, maxRounds: 16 } },
    { id: 'c-blitz-4', version: 1, kind: 'challenge', name: 'Blitz Table', seed: 'chal-blitz', theme: 'midnight-espresso',
      goal: 'Four players, 4 rounds max — highest score takes it.', players: 4, ai: ['hard', 'medium', 'hard'], ruleset: { targetScore: 0, maxRounds: 4 } },
    { id: 'c-minimalist', version: 1, kind: 'challenge', name: 'Minimalist', seed: 'chal-min', theme: 'mono-ink',
      goal: 'Reach 50 in 5 rounds or fewer.', players: 2, ai: ['hard'], ruleset: { targetScore: 50, maxRounds: 5 } },
  ];

  function challengeToConfig(ch, playerName) {
    const players = [{ id: 'you', name: playerName || 'You', kind: 'human' }];
    for (let i = 1; i < ch.players; i++)
      players.push({ id: 'ai' + i, name: AI_NAMES[(i * 5 + 1) % AI_NAMES.length], kind: 'ai', difficulty: ch.ai[i - 1] || 'medium' });
    return { seed: ch.seed, ruleset: ch.ruleset, players };
  }

  /* ---------------------------------------------------------------- Daily */
  // One shared seed + ruleset per UTC day. Immutable once computed.
  const DAILY_RULESETS = [
    { targetScore: 60, drawRule: 'until-playable', players: 2, ai: ['medium'], theme: 'ceramic-classic' },
    { targetScore: 80, drawRule: 'one', players: 2, ai: ['hard'], theme: 'midnight-espresso' },
    { targetScore: 60, drawRule: 'none', players: 2, ai: ['medium'], theme: 'mono-ink' },
    { targetScore: 90, drawRule: 'until-playable', players: 3, ai: ['medium', 'hard'], theme: 'sage-garden' },
    { targetScore: 70, drawRule: 'one', players: 3, ai: ['hard', 'medium'], theme: 'terracotta-sun' },
    { targetScore: 100, drawRule: 'until-playable', players: 4, ai: ['medium', 'medium', 'hard'], theme: 'sage-garden' },
    { targetScore: 50, drawRule: 'none', players: 2, ai: ['hard'], theme: 'midnight-espresso' },
  ];

  function dailyForDate(date) {
    const d = date || new Date();
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const epochDay = Math.floor(Date.UTC(y, m, day) / 86400000);
    const template = DAILY_RULESETS[((epochDay % 7) + 7) % 7];
    return {
      id: 'daily-' + key, version: CONTENT_VERSION, kind: 'daily', dateKey: key,
      name: 'Daily Table — ' + key, seed: 'daily:' + key, theme: template.theme,
      players: template.players, ai: template.ai.slice(),
      ruleset: { targetScore: template.targetScore, drawRule: template.drawRule },
      goal: 'Today\'s shared table: first to ' + template.targetScore +
        (template.drawRule === 'none' ? ', boneyard closed' : template.drawRule === 'one' ? ', one draw per turn' : '') + '.',
    };
  }

  function dailyToConfig(daily, playerName) {
    const players = [{ id: 'you', name: playerName || 'You', kind: 'human' }];
    for (let i = 1; i < daily.players; i++)
      players.push({ id: 'ai' + i, name: AI_NAMES[(i * 2 + 2) % AI_NAMES.length], kind: 'ai', difficulty: daily.ai[i - 1] || 'medium' });
    return { seed: daily.seed, ruleset: daily.ruleset, players };
  }

  /* ------------------------------------------------------- Practice setup */
  function practiceConfig(opts, playerName) {
    const n = Math.min(4, Math.max(2, opts.players || 2));
    const players = [{ id: 'you', name: playerName || 'You', kind: 'human' }];
    for (let i = 1; i < n; i++)
      players.push({ id: 'ai' + i, name: AI_NAMES[(i + 2) % AI_NAMES.length], kind: 'ai', difficulty: opts.difficulty || 'medium' });
    return {
      seed: 'practice:' + (opts.seed || ('p' + Date.now())),
      ruleset: {
        targetScore: opts.targetScore || 100,
        drawRule: opts.drawRule || 'until-playable',
        maxRounds: opts.maxRounds || 12,
      },
      players,
    };
  }

  /* ---------------------------------------------------------- Validation */
  // Offline validator: legality, reachable goals, bounded duration, no soft
  // locks. Drives every stage/challenge/daily template with scripted AI.
  function validateContent(aiMove) {
    const problems = [];
    const items = []
      .concat(JOURNEY.map(s => ({ item: s, cfg: stageToConfig(s) })))
      .concat(CHALLENGES.map(c => ({ item: c, cfg: challengeToConfig(c) })));
    for (const { item, cfg } of items) {
      for (const variant of ['a', 'b']) {
        const c = Object.assign({}, cfg, { seed: cfg.seed + ':' + variant });
        const state = R.createMatch(c);
        let guard = 0;
        const HARD_LIMIT = 4000;
        while (state.phase !== 'match-over' && guard++ < HARD_LIMIT) {
          if (state.phase === 'round-over') { R.nextRound(state); continue; }
          const acts = R.legalActions(state, state.turn);
          if (acts.length === 0) { problems.push(item.id + ': active phase with no legal actions'); break; }
          const a = aiMove(state, acts, state.players[state.turn]);
          const r = R.applyCommand(state, state.turn, a);
          if (!r.ok) { problems.push(item.id + ': legal action rejected (' + r.reason + ')'); break; }
        }
        if (guard >= HARD_LIMIT) problems.push(item.id + ': exceeded duration bound (possible soft lock)');
        else if (state.phase !== 'match-over') problems.push(item.id + ': did not reach terminal state');
      }
    }
    // Tutorials: steps must be performable in order.
    for (const t of TUTORIALS) {
      const state = R.createCustomState(t.setup);
      for (const step of t.steps) {
        if (step.expect.type === 'opponent' || step.expect.type === 'opponent-pass') {
          // scripted guide: pick any legal action (or pass)
          const acts = R.legalActions(state, state.turn);
          if (!acts.length) { problems.push(t.id + ': guide has no action in step "' + step.text.slice(0, 24) + '"'); break; }
          const pick = step.expect.type === 'opponent-pass'
            ? (acts.find(a => a.type === 'pass') || acts[0]) : acts[0];
          const r = R.applyCommand(state, state.turn, pick);
          if (!r.ok) { problems.push(t.id + ': guide action rejected: ' + r.reason); break; }
          continue;
        }
        const want = step.expect;
        const acts = R.legalActions(state, state.turn);
        const match = acts.find(a =>
          a.type === want.type &&
          (want.tileId === undefined || a.tileId === want.tileId) &&
          (want.end === undefined || a.end === want.end));
        if (!match) { problems.push(t.id + ': expected action not legal in step "' + step.text.slice(0, 30) + '"'); break; }
        const r = R.applyCommand(state, state.turn, match);
        if (!r.ok) { problems.push(t.id + ': expected action rejected: ' + r.reason); break; }
      }
    }
    return problems;
  }

  return {
    CONTENT_VERSION, THEMES, CVD_PALETTES, TUTORIALS, JOURNEY, CHALLENGES,
    stageToConfig, challengeToConfig, dailyForDate, dailyToConfig, practiceConfig, validateContent,
    themeById(id) { return THEMES.find(t => t.id === id) || THEMES[0]; },
  };
});
