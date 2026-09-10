# Chain Dominoes — Game Design Document (running spec)

**Status:** shipped, v1.0.0 (`starhermit.txt`), content version 1. This document describes what the game does today, in
present tense. Anything the design wants that the code does not yet do is listed once, at the end, under
"Design intent not yet implemented".

## 1. Overview

**Pitch.** A café-table game of matching ends and light hands: extend a serpentine chain of ceramic dominoes on green
felt, go out first or hold the fewest pips when the table locks, and race an opponent to a target score.

| | |
|---|---|
| Genre | Turn-based tile game (draw dominoes, double-six set) |
| Players | 1 human vs 1-3 deterministic AI seats; 2 humans pass-and-play on one device; 2-4 humans through the hosted Game Script |
| Session | One lesson 1-2 min; a journey stage 5-15 min; a daily table 5-10 min; a challenge 3-15 min |
| Platforms | Desktop and mobile browsers, any orientation (`orientation=any`) |
| Rendering | Three.js r-module (`vendor/three.module.min.js`) café tabletop on a `<canvas>`, plus a complete semantic HTML mirror (hand listbox, chain strip, end caps, action buttons). The canvas is optional: if WebGL or Three.js fails the DOM layer plays the whole game |
| Dependencies | None at runtime. `playwright-core` (dev) for `tests/e2e.mjs` |

### File map

| Path | Role |
|---|---|
| `index.html` | All screens, overlays, live regions, key-art and results-art `<img>` slots; loads Three.js as a module then the classic scripts below in order |
| `css/style.css` | Palette tokens, grid layouts (wide / compact / portrait / landscape), a11y modes, key-art and results-art styling |
| `js/rules.js` | Pure rules engine: tile set, seeded RNG streams, `createMatch`, legality, `applyCommand`, scoring, ranking, hashing, replay. Shared verbatim with `server.js` |
| `js/content.js` | Themes (5), lessons (6), journey stages (40), challenges (8), daily generator, practice config, offline validator |
| `js/ai.js` | `chooseMove(state, seat, difficulty, rng)`: easy / medium / hard, seeded |
| `js/session.js` | `Session`: one match; commands, AI scheduling, clock, undo, hints, lesson step engine, replay envelope, progression, achievements |
| `js/render3d.js` | `ChainRenderer`: authored camera, procedural tiles/props/textures, pick raycasts, legal-end markers, quality tiers, reduced motion, `settle()` |
| `js/ui.js` | `UI`: screens, setup flows, HUD, DOM mirror, keyboard/gamepad, overlays, settings, profile, help, captions |
| `js/audio.js` | `AudioEngine`: 4 buses, 39 sampled one-shots with synth fallbacks, seeded variants, café ambience, generative pad |
| `js/platform.js` | `Store` (checksummed local save), achievements, telemetry (consent-gated), local leaderboard, StarHermit host adapter |
| `js/main.js` | Boot: store, host handshake, cloud-conflict check, `window.__CD_UI` |
| `server.js` | Authoritative hosted-play Game Script (`createSession` / `submitCommand` / `getSnapshot` / `tick` / `endSession` / `getReplay`) |
| `sfx/` | 39 Opus clips; `manifest.txt` (canonical binding), `manifest.json` (generator input), `manifest.md` (generated) |
| `assets/` | `key-art.webp` (title backdrop), `results-win.webp`, `results-over.webp` |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200x675), touch icon, tab icon |
| `tests/` | `rules.test.js`, `content.test.js`, `server.test.js` (`npm test`); `e2e.mjs` (Playwright); `browser.test.js` (raw CDP, legacy); probes |
| `knownissues.md` | QA history: confirmed defects and their fixes |

## 2. Vision and design pillars

1. **The table tells the truth.** Every fact a player needs — the two open ends, which hand tiles can play, whose turn
   it is, how many tiles the boneyard holds — is shown simultaneously in the 3D scene and in plain DOM text. Rules in:
   large end values in the left rail and on the end caps, dimmed unplayable tiles, a boneyard count. Rules out: hidden
   modifiers, hover-only information, any state that exists only inside the canvas.
2. **One deliberate touch places a tile.** Select a tile, then tap the end you want; a tile with a single legal end
   commits on a second tap or Enter. Rules in: end caps that appear only when legal, ghost preview at the hovered end,
   ack sound plus haptic on every input. Rules out: drag-and-drop as the only path, timed inputs in the core loop,
   double-commit bugs (every command carries an action id).
3. **Fair, replayable luck.** One seed drives independent streams for the deal, AI tie-breaks, décor and audio
   variants; the results screen prints the seed and the envelope replays to an identical hash. Rules in: daily tables
   with one seed for everyone, undo that rewinds the envelope too. Rules out: reshuffles behind the player's back,
   client-authored winners in hosted play.
4. **Learn by doing, never by reading a wall.** Lessons craft a tiny position and accept only the taught move; hints
   use the hard AI, the same code that plays against you. Rules in: six 1-5 step lessons, help cards generated from the
   current key bindings. Rules out: tutorials that play themselves, modal rule dumps before the first tile.
5. **A quiet café, not a casino.** Warm wood, green felt, ceramic clacks, steam from a cup. Effects sit below the
   information: no bloom, no particles over the chain, a 0.15 shake at round end that reduced motion removes.
   Rules out: strobing, camera swoops the player cannot skip, sounds that fire without a logical event.

## 3. Player experience

**Target player.** Someone who knows or half-remembers dominoes and wants a five-minute table on a phone or a
longer sit-down against tougher AI on a desktop; also the accessibility-first player who needs full keyboard,
screen-reader and reduced-motion support without a lesser game.

**First 60 seconds.** Title shows key art, "Play" and the mode list. A fresh profile pressing Play (`ui.js
_quickPlay`) is sent straight into Lesson 1 "Match the Ends": a 2|4 already on the table, two tiles in hand, a banner
saying "play 4|6 on the RIGHT end" with that tile glowing. The player taps it, the right end cap appears, taps it, hears
the clack, sees the guide answer, then passes. The lesson closes on the results overlay ("Match the Ends — complete",
"Next lesson"). Anyone who skips lessons still gets the same guidance in play: unplayable tiles dim, the end caps only
appear for legal ends, and every rejection is explained in words ("That tile does not match that end").

**Session shape.** Round intro (shuffle, deal, chime, camera swoop) → alternating turns of 0.5-1.2 s AI thinking →
round-over card with pip totals per seat → next round → results with score breakdown, stars and seed → "Play again",
"Next stage" or "Menu". Leaving mid-match stores a resumable snapshot; the title then shows "Continue Match".

**Emotional beat.** The moment the last tile leaves your hand, or the moment the table locks and you realise your
1-pip tile beats their 7. Both are scored transparently on the round card, in the player's own vocabulary
("You held 5 pips", "+16").

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates state. State is plain JSON (`version`, `seed`, `ruleset`,
`players[]`, `round`, `tick`, `phase`, `turn`, `chain[]`, `leftEnd`, `rightEnd`, `hands[][]`, `boneyard[]`,
`passesInRow`, `lastAction`, `terminal`, `roundResult`, `rng`, `log[]`).

| Rule | As implemented | Owner |
|---|---|---|
| Tile set | Double-six, 28 tiles; `id` enumerates `(a,b)` with `a<=b`; `pips=a+b` | `tileSet(6)` |
| Ruleset | `maxPip 6`, `targetScore 100` (0 = single match to best score), `maxRounds 12`, `drawRule` one of `until-playable` / `one` / `none`, `moveLimit 0`; `spinners` exists but is unused | `DEFAULT_RULESET`, `normalizeRuleset` |
| Deal | Fisher-Yates over tile ids with the `seed:rules` stream; 7 tiles each for 2 players, 5 for 3-4; remainder is the boneyard in fixed draw order | `startRound` |
| Opener | Highest double dealt; if none, highest pip tile; ties go to the lowest seat index | `openingPlayer` |
| Play | A tile is legal on an end if either face equals that end's value; the first tile of a round goes on the `right` and sets both ends. Left plays `unshift`, right plays `push`; the outward face becomes the new end. Doubles are rendered crosswise but obey the same rule | `playableEnds`, `doPlay` |
| Must play | If any tile can play (and the seat is under `moveLimit`), draw and pass are rejected with `must-play-if-able` | `invalidReason` |
| Draw | Takes `boneyard[0]`. `until-playable`: the seat keeps the turn and must draw again or play. `one`: if the drawn tile still cannot play the seat auto-passes (`event.autoPass`). `none`: `draw-disabled` | `doDraw`, `legalActions` |
| Pass | Legal only with no playable tile and (boneyard empty, or drawing disabled, or the one permitted draw taken); otherwise `must-draw-first` | `doPass` |
| Blocked round | `passesInRow >= players.length` ends the round with reason `blocked` | `checkBlockedOrAdvance` |
| Domino | A play that empties the hand ends the round with reason `domino` | `doPlay` → `endRound` |
| Round score | Winner(s) receive `sum(other seats' pips) − own remainder` (own remainder is 0 on a domino), floored at 0. Blocked rounds can have co-winners on equal lowest pips; each scores their own margin | `endRound` |
| Match end | After a round: any score `>= targetScore` (when `> 0`) → `target-reached`; `round >= maxRounds` → `rounds-exhausted`; every seat at `moveLimit` or empty-handed → `move-limit`. Otherwise `phase='round-over'` and `nextRound` re-deals from the saved RNG cursor | `endRound`, `finishMatch`, `nextRound` |
| Ranking / ties | Score desc, then fewer `invalidActions`, then fewer own actions (`plays+draws+passes`), then player id. `terminal.tied` is true only when all three are equal | `rankPlayers`, `finishMatch` |
| Invalid attempts | Counted per seat and never change play state; reason codes: `not-your-turn`, `tile-not-in-hand`, `bad-end`, `no-matching-end`, `must-play-if-able`, `boneyard-empty`, `must-draw-first`, `draw-disabled`, `draw-limit-one`, `move-limit-reached`, `round-over`, `game-over`, `malformed-command`, `unknown-command` | `applyCommand`, `invalidReason` |
| Time limit | Challenges with `timeLimitSec` end the match at expiry with `time-expired`; highest score wins (×1.5 limit with timing assistance) | `session.js _finishByTimeout` |
| RNG | FNV-1a hash of `seed + ':rules' / ':decor' / ':av'` seeding mulberry32; the AI uses `seed + ':ai'`. `state.rng` stores the rules cursor so later rounds continue the stream | `makeStreams`, `startRound` |
| Hash / replay | `stateHash` = FNV-1a over a sorted-key stringify with `log` removed. `replay(cfg, log)` re-applies commands (including `next-round` markers) and returns the final hash | `stateHash`, `replay` |
| Undo | Practice, journey and lessons only; pops snapshots until the human's previous decision point and truncates the replay envelope to match | `session.js undo`, `_pushUndo` |
| Hint | `AI.chooseMove(state, me, 'hard')`; highlights the tile for 2.2 s and announces "Try 4|6 on the right." Off in daily and challenges | `session.js hint` |

**Worked example.** Three seats, blocked round, remaining pips `[5, 12, 9]`. Lowest is seat 0, so
`fromOpponents = 12 + 9 = 21`, `ownRemainder = 5`, `points = 16`; seat 0's score rises by 16. Had seat 1 instead gone
domino with the others holding 5 and 9, seat 1 would score `14 − 0 = 14`. With `targetScore 30`, a seat on 16 who
scores 14 or more next round ends the match with `target-reached`.

**Journey stars** (`session.js _starsFor`): 1 for winning; +1 if the winning margin is ≥ 20 or the match finished
within the stage's `par.rounds`; +1 if the player made zero invalid actions. Maximum 3, best kept per stage.

## 5. Modes and progression

| Mode | Entry | Configuration | Ranked | Undo / hints |
|---|---|---|---|---|
| Learn | "Learn to Play" → lesson card | 6 authored positions (`content.js TUTORIALS`), `targetScore 0`, scripted guide seat; only the expected action type is accepted (`_tutorialAllows`) | No | Undo yes, hints yes |
| Journey | "Journey" → stage list | 40 stages `j1`-`j40`: 2-4 seats, easy→hard AI, targets 30→150, `drawRule` and `maxRounds` twists, mastery stages at 8/16/24/32/40. A stage unlocks when the previous one has ≥1 star | Local board + host submit | Undo yes, hints yes |
| Daily | "Daily Table" (badge "done" after playing) | `dailyForDate(hostTime)`: `seed 'daily:YYYY-MM-DD'`, one of 7 rulesets by `epochDay % 7` (2-4 seats, 50-100 target, all draw rules). First result of the day is the recorded one | Yes | Neither |
| Practice | "Practice" → form | 2-4 seats, easy/medium/hard, target 50/100/150, draw rule; seed `practice:p<timestamp>` | No | Undo yes, hints yes |
| Challenge | "Challenges" → 8 cards | Speed Roast (240 s), Frugal Fingers (`moveLimit 22`), Dry Counter (`none`), Outnumbered (3 hard), One Sip (`one`), Bottomless Cup (150, 16 rounds), Blitz Table (4 rounds, best score), Minimalist (5 rounds) | Yes | Neither |
| Pass & Play / Hosted Play | Same button, relabelled by host presence | Offline: two human seats, `seed 'hotseat:<timestamp>'`, control and the visible hand follow the turn. Hosted: "Create private invitation" and "Find public match" post to the host API | No (offline) | Undo yes offline |
| Continue Match | Shown when a snapshot exists | Restores mode, content, config, state and elapsed time (`_continueSaved`) | As original | As original |

**Difficulty curve.** Stages 1-7 introduce one idea each (`tutorialFlags`: matching, ends, drawing, doubles, pips,
medium AI, one-draw). 9-15 add seats. 12-13 add round caps and closed boneyards. 20 introduces the hard AI. From 24 on
every stage is 3-4 seats or hard AI, and 40 is four hard seats to 150 with one draw per turn. AI names rotate through
`AI_NAMES` (Marta, Theo, Ines, Kofi, Sana, Piotr, Lena, Rui).

**AI** (`js/ai.js`). Easy: uniform random legal action. Medium: scores each play by pips shed + 2 per end value still
covered in hand, then picks randomly among candidates within 3 of the best. Hard: adds +1.5 for doubles, +2 for
dumping the heaviest tile, +100 for going out, +3 for closing both ends on the same value after an opponent pass;
deterministic tie-break by tile id then end. Lessons use `'scripted'`, which routes to easy.

**Achievements** (`platform.js ACHIEVEMENTS`, idempotent): `first_win`, `mechanic_mastery` (all six lessons),
`streak_5`, `milestone_hard` (win a mastery stage numbered ≥ 32), `marathon_100`, `daily_7`, `journey_complete`.

## 6. Controls and interaction

| Intent | Mouse / touch | Keyboard (default bindings, `platform.js`) | Gamepad |
|---|---|---|---|
| Select a hand tile | Tap the tile in the tray or its 3D mesh | `←` / `→` moves selection and focus | D-pad / left stick |
| Place on an end | Tap the end cap button or the 3D end ring; second tap on a tile with one legal end commits | `A` left end, `D` right end, `Enter` commits when exactly one end is legal | LB left, RB right, A commits single end |
| Deselect | Tap the table | `Escape` | B |
| Draw / Pass | Buttons (shown only when legal) | `W` / `S` | X draws |
| Hint / Undo | Buttons (hidden when not allowed) | `H` / `U` | Y hints |
| Pause | ☰ button | `P`; `Escape` closes the pause overlay only | Start |
| Skip animation | "Skip anim" runs all pending AI turns and `settle()`s the scene | — | — |
| Camera reset | — | `C` | — |

Input rules: `Session.act` refuses commands while paused or finished and dedupes by action id; a 3D tap is a
pointer-up within 450 ms and 12 px of pointer-down (`render3d.js _bindPointer`), so drags never place tiles. Every
accepted input plays `ack` (`ui-click`), every selection `select` (`tile-pickup`), every rejection `invalid`
(`ui-error`) plus a `[30,40,30]` vibration when haptics are on. The chain strip and hand tray are always usable even
when the canvas is absent.

## 7. Screens and UI flow

`title → learn | journey | setup(practice · daily · challenges · hosted) | profile | settings | help → game`.
The game screen owns three overlays: `overlay-pause` (Resume / Settings / How to Play / Leave), `overlay-round`
(pip totals, points, match score, Next round) and `overlay-results` (heading, results art, stars, breakdown, unlocks,
meta line with reason · rounds · time · seed, Play again / Next stage / Menu). Lessons reuse the results overlay with
"Next lesson" via `_resultsRetryOverride`. Overlays trap Tab focus and restore focus on close.

Layouts (`css/style.css`):

- **Wide ≥ 1024 px.** Grid `status / left rail 240 · playfield · right rail 220 / hand tray`. Left rail: open ends
  (big digits), round and target, boneyard count, draw rule. Right rail: Draw, Pass, Hint, Undo, Skip, turn indicator.
- **Compact 601-1023 px.** Left rail becomes a slide-in drawer (☰ Table toggle), right rail collapses to a 64 px icon
  column with a vertical turn indicator.
- **Portrait ≤ 600 px.** Single column: status bar (objective ellipsised to 34 vw, scrollable score chips), playfield,
  action row, hand tray; the left rail is a bottom sheet. Tiles enlarge to 40x70 px.
- **Landscape ≤ 900 x 500 px.** Playfield plus a 64 px action column, 30x52 px tiles, tighter tray and banner.
- Safe areas: every screen and the status bar / tray pad by `env(safe-area-inset-*)`; the toast and captions sit above
  the bottom inset. The title key art is a positioned background that never receives input.

Must never be cut off: the hand tray (primary control surface), the end caps, Draw/Pass, the pause button, the
tutorial banner text, and the overlay action buttons (overlay cards scroll internally; results art is dropped below
640 px of viewport height).

## 8. Art direction

**Hero.** The chain itself: cream ceramic tiles with rounded, bevelled edges lying on green felt over walnut, lit by a
warm window key light with a small accent-coloured pendant. The player's hand stands upright in an arc at the front;
opponents' hands stand face-down at their table edges; the boneyard stacks face-down at the right.

**Palettes** (`content.js THEMES`; CSS tokens come from `css`, scene colours from the hex fields):

| Theme | bg | panel | text | accent | good | bad | table | felt | tile body | pip |
|---|---|---|---|---|---|---|---|---|---|---|
| Ceramic Classic (default) | `#241c15` | `#2f261d` | `#f2ead9` | `#d98e3a` | `#6fbf8f` | `#e06c5c` | `#7a5a3a` | `#2e5d4b` | `#f4efe4` | `#2b2b30` |
| Midnight Espresso | `#141114` | `#1e1a1e` | `#ece4d2` | `#c9a227` | `#7fc9a9` | `#e07a6a` | `#3a2e28` | `#1f3230` | `#39424f` | `#f2ecd8` |
| Sage Garden | `#1d241a` | `#27301f` | `#f0efe0` | `#8fbf7f` | `#8fbf7f` | `#e08a6c` | `#9a7d55` | `#5e7d5a` | `#f7f3e8` | `#33412f` |
| Terracotta Sun | `#2a1710` | `#382014` | `#f7ecd8` | `#e07b39` | `#7fbf9f` | `#e05c4c` | `#a5663f` | `#8a4b32` | `#fdf6e9` | `#4a2c1a` |
| Mono Ink | `#131316` | `#1c1c21` | `#f2f2f5` | `#ffffff` | `#a8d8b8` | `#e89a92` | `#4a4a4f` | `#2c2c31` | `#ececf0` | `#17171c` |

Fixed tokens: focus ring `#ffd27a`, muted text `#b8ac97`, danger button `#57251d`/`#7d3a2e`. High contrast swaps to
`#000` / `#fff` / `#ffd24a` / `#6fd3ff`. Colour-vision palettes remap good/bad/accent-2 to `#4fa8e0` / `#e0b04f`
(protan/deutan) or `#4fd0c9` / `#e06c8a` (tritan); legality is also encoded by dimming and by the words "playable"
/ "not playable now" in each tile's label, never by colour alone.

**Shape and type.** Rounded rectangles everywhere (12 px radius panels, 7 px tiles, pill score chips). Pips are drawn
procedurally in both DOM (3x3 grid) and canvas textures (128x256 per face, cached per theme). Typography is the
system stack `"Avenir Next", "Segoe UI", system-ui`; the title scales `clamp(2rem, 6vw, 3.4rem)`; rail titles are
uppercase 0.8 rem with 0.1 em tracking.

**Scene constants** (`render3d.js`): perspective fov 38 (54 in portrait), camera `[0,26,30]` looking at `[0,0,-2]`,
intro swoop from `[0,40,52]` over 1.4 s cubic ease; table 72 units, felt 56x44; tile 2x4x0.85 with 0.35 gap; chain
rows of 30 units advancing 5.2 per row in a serpentine. ACES filmic tone mapping, exposure 1.05 (Midnight 1.55, Mono
1.2), fog from 70 to 160 in the theme fog colour, no post-processing. Quality tiers: low (pixel ratio 1, no shadows,
24 steam points), medium (1.5, 1024 px PCF soft shadows, 60), high (2, 120); "Auto" picks by UA and core count.

**Motion.** Tiles move on a critically damped spring (k = 90); selection lifts 0.9 units and adds a 0.25 emissive
tint plus a grounded ring; end rings pulse ±8 %; steam drifts on the CPU; the round-end shake is 0.15 units decaying.
Reduced motion (setting or `prefers-reduced-motion`) snaps tiles, skips the intro swoop, stops steam and shake, and
collapses CSS transitions to 0.01 ms. "Skip anim" always lands the scene in the exact logical end state.

**Visual assets the design calls for.** Title key art (café table, chain, cup, warm light) behind the menu; two
results illustrations, one for a win and one for a lost or blocked table; a cover image built from the key art.
Tiles, felt, wood, cup and steam stay procedural so every theme recolours them without new files.

## 9. Audio direction

Mix: effects carry the information (every logical event has one short ceramic or wooden transient), ambience is a
low-passed brown-noise café room tone at 0.16 gain, music is a generative four-chord sine pad (C, Am, F, G every 3.4 s)
detuned per seed. Four gain buses — music 0.5, effects 0.8, ambience 0.4, voice 0.8 (reserved, honoured by the slider)
— under a master mute. The context is created on the first pointer or key gesture; clips decode lazily, and every cue
has a synthesized fallback so nothing goes silent while loading. Successive plays within 2.6 s escalate a combo layer
(`_comboStreak`). Each cue also posts a caption ("tile placed", "table blocked") that the UI shows for 1.2 s.

The table below is the source of `sfx/manifest.txt`. Event ids are `AudioEngine` methods in `js/audio.js`.

| Event id | File | Sound | Usage |
|---|---|---|---|
| ack | ui-click.opus | Short ceramic button click on wood | Every acknowledged input |
| hover | ui-hover.opus | Very short soft ceramic tick | Pointer enters any control |
| confirm | ui-confirm.opus | Warm two-note chime | Match starts |
| back | ui-back.opus | Soft descending tone | Return to title |
| invalid | ui-error.opus | Muted double ceramic clack | Rejected command |
| success | ui-success.opus | Bright ascending three-note chime | Achievement unlocked |
| modalOpen / panelClose | ui-modal-open.opus / panel-close.opus | Felt whoosh with chime / felt panel shut | Round or results overlay opens / closes |
| toggle | ui-toggle.opus | Small switch click | Settings checkbox |
| tabSwitch | tab-switch.opus | Light ceramic chip tap | Leaderboard tab |
| scrollTick | scroll-tick.opus | Ceramic beads in a pouch | Keyboard/gamepad hand navigation |
| sliderDrag | slider-drag.opus | Ceramic piece dragged on felt | Volume slider (throttled 120 ms) |
| toast | toast-notification.opus | Porcelain bell struck once | Toast shown |
| gamePause / gameResume | game-pause.opus / game-resume.opus | Two muffled notes down / up | Pause overlay opens / closes |
| countdownTick | countdown-tick.opus | Crisp ceramic tick | Last 5 s of a speed challenge, per second |
| timerWarning | timer-warning.opus | Three urgent ceramic clicks | Speed challenge crosses 10 s left |
| select | tile-pickup.opus | Tile lifted off wood | Hand tile selected |
| place | tile-place.opus (+ combo-low / combo-mid / combo-high) | Single firm clack (+ double tap / triple clicks / cascade) | Any tile played (+ 2-3 / 4-5 / 6+ quick successive plays) |
| draw | tile-draw.opus + tile-flip.opus | Slide-and-click, then a face-up snap 250 ms later | Draw from the boneyard |
| pass | pass-knock.opus | Two knuckle knocks | Pass |
| roundIntro | tile-shuffle.opus, tile-deal.opus (+1.0 s), round-start.opus (+2.0 s) | Shuffle clatter, dealt slides, bright chime | Match start and every Next round |
| turnYou | turn-you.opus | Espresso cup tapped with a teaspoon | Turn returns to the human after AI moves |
| opponentTurn | opponent-turn.opus | Soft double knock with a tick | AI seat begins thinking |
| hint | hint-glow.opus | Glass-and-ceramic glissando | Hint shown |
| undoMove | move-undo.opus | Reversed whoosh into a lifted tile | Undo |
| tableBlocked | table-blocked.opus | Two tiles knocked, then a palm thud on wood | Round ends blocked (0.7 s before the round sting) |
| roundWin / roundLose | round-win.opus / round-lose.opus | Clinking fanfare / subdued marimba phrase | Round result for the local seat |
| matchWin / matchLose | match-win.opus / match-lose.opus | Extended fanfare / gentle descending marimba | Results overlay |
| star | star-award.opus | Sparkling chime with a ceramic pop | One per journey star, staggered |
| newRecord | new-record.opus | Rising chime cascade | New best score on a replayed stage |

## 10. Localization

The shipped build is **English only** (`<html lang="en">`); there is no string table. UI copy lives inline in
`index.html`, in `js/ui.js` (setup facts, results headings, help cards, toasts), in `js/session.js` (rejection
reasons `_reasonText`, live-region announcements, hint text) and in `js/content.js` (stage, challenge and lesson
names and step text). Language is therefore not selectable. The target locale set for the product — en-US, en-GB,
es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — is recorded under "Design intent not yet implemented". Layout
already tolerates ~30 % longer strings: buttons are flex with wrapping labels, the objective ellipsises, rails
scroll, and overlay cards scroll internally.

## 11. Accessibility

- **Keyboard-only path.** Title → any screen via Tab/Enter; in play, arrows select tiles, `A`/`D`/`Enter` place,
  `W`/`S` draw/pass, `P` pauses, `U`/`H` undo/hint, `C` resets the camera. Overlays trap focus and return it to the
  opener. A skip link jumps to the playfield. Focus rings are 3 px `#ffd27a` (`:focus-visible`).
- **Screen readers.** `#sr-live` (polite) receives lesson steps, turn prompts with the open ends ("Your turn. Ends
  are 2 and 6."), round and match results, undo/hint text and pass-and-play hand-overs; `#sr-assertive` receives
  rejections. The hand is a `listbox` of `option` buttons labelled "4 | 6 domino, playable"; chain tiles are
  `img`s labelled "4|6 on the table"; end caps are labelled "Play selected tile on right end (4)". Overlays are
  `role=dialog aria-modal`.
- **Captions.** Every audio cue mirrors to `#overlay-captions` ("♪ tile placed") for 1.2 s; no information is
  audio-only.
- **Contrast and colour.** High-contrast mode (black/white/yellow tokens, 2 px white tile outlines), three
  colour-vision palettes, optional numerals on tiles ("Show numbers on tiles"), larger text (19 px base, 42x74 px
  tiles).
- **Motion and timing.** Reduce-motion setting plus media query; timing assistance multiplies challenge limits by
  1.5; haptics can be disabled; a left-handed layout mirrors the rails and status bar.
- **Targets.** Buttons are ≥ 44x44 CSS px (`--tap`), tiles 34x60 to 42x74 px with 8 px gaps, end caps 44 px circles.

## 12. StarHermit integration

Detection: the host shell injects `window.__STARHERMIT__ = { launchToken, scopeHint }`; `platform.js host.init`
decodes the token's `game`/`scope` claim (fallback `chain-dominoes`), keeps the bearer in memory only, and never
probes `/api/v1/time` on plain static hosting (so an offline run logs no console errors).

| Platform feature | Used | How |
|---|---|---|
| Identity / profile | Yes | Guest profile by default; "Signed in — cloud saves active" when a launch token is present. Display name is editable locally |
| Server time | Yes | `GET /api/v1/time` (`now` / `serverTime` / `epochMs`), round-trip-adjusted offset drives the daily seed |
| Cloud save | Yes | `GET`/`PUT /api/v1/games/{scope}/save` with `{version, checksum, payload}`; a strictly newer remote document opens the Profile "Save conflict" panel where the player keeps one |
| Presence / activity | Yes | `POST /api/v1/presence` every 60 s during a match; `POST /api/v1/activity/start` on match start and `/end` with minutes on leave or `pagehide` |
| Leaderboards | Yes | Journey, daily and challenge results post `{score, won, ruleset, contentVersion, seed, mode, assists, durationMs, ticks}` to `POST /api/v1/games/{scope}/scores`; Profile reads `/leaderboards/global` and `/daily`; offline it shows the on-device board |
| Achievements | Local | Seven keys unlock idempotently in the local save; no server unlock call |
| Sessions / Game Script | Yes | `starhermit.txt` declares `server=server.js`. The script validates membership, connection, command-id shape, duplicates (idempotent `ok:true, duplicate:true`), payload ≤ 512 bytes and rules legality; public views expose other seats only as `handCount` and the boneyard as a count; `tick` forfeits the seat that lets a turn deadline (≥ 5 s, default 45 s) lapse and resolves sessions parked at round-over; `getReplay` returns the ordered log and final hash |
| Invitations / matchmaking | Best-effort | "Create private invitation" posts to `/api/v1/games/chain-dominoes/sessions`, "Find public match" to `/matchmaking`; failures surface as announcements. There is no in-client transport that drives `server.js` from two browsers |
| Telemetry | Opt-in | `start`, `tutorial-step`, `round-end`, `retry`, `settings-change`, `error` to `POST /api/v1/telemetry` only after consent |
| Token refresh | Available | `POST /api/v1/auth/refresh` (memory only) |
| Chat, voice, friends panel, rating, containers | No | Not implemented |

## 13. Technical architecture

- **Boot.** `main.js` builds `Store` (localStorage `chaindominoes.save.v1`, FNV-1a checksum envelope; a corrupt or
  mismatched envelope starts fresh), calls `host.init`, constructs `UI` and exposes it as `window.__CD_UI` for tests.
- **Data flow.** `UI` → `Session.act(cmd, actionId)` → `rules.applyCommand` → `Session._afterCommand` builds an
  immutable view (`buildView`) → `renderer.syncState(view)` and `UI._renderView(view)`. AI turns are `setTimeout`s
  (550-1150 ms, seeded jitter; 650 ms in lessons) that clear any pending timer first.
- **Determinism and replay.** The replay envelope holds `version, build, contentVersion, seed, initialHash,
  startedAt, commands[], hashes[], terminal`; undo truncates it. `rules.replay` verifies it in tests. Décor
  (sugar cubes, steam) uses a theme-derived stream; audio variants use the `av` stream — neither touches rules.
- **Persistence.** Settings, progress (journey stars/best, lessons, achievements, stats, daily results, mastery XP)
  and a resumable `savedMatch` snapshot live in one document; the local leaderboard is `chaindominoes.localboard.v1`
  (top 100); telemetry consent is `chaindominoes.telemetry-consent`.
- **Rendering budgets.** Measured at the default tier: about 66 draw calls and 10 k triangles, against budgets of
  150 calls / 350 k triangles desktop and 90 / 140 k mobile. Pixel ratio is capped per tier; geometry, textures and
  materials are disposed on `dispose()`; the loop pauses while the tab is hidden or the game is paused.
- **Resilience.** No Three.js or no WebGL → `#webgl-fallback` note and the DOM controls; sample fetch failures →
  synthesis; storage failures → in-memory session; `pagehide` stores the active match.
- **How the e2e test drives the UI.** `tests/e2e.mjs` serves the repo from an embedded `node:http` server
  (ephemeral port, or `PORT`), launches system Chrome through `playwright-core`, and clicks real controls
  (`#btn-learn`, `.card-go`, `#hand-list .domino`, `#btn-end-left/right`, `#btn-draw`, `#btn-pass`,
  `#btn-next-round`, `#btn-results-retry`, `#btn-pause`, settings toggles). It reads `window.__CD_UI.game.state`
  only to decide which visible control to press next.

## 14. Testing and acceptance criteria

`npm test` = `tests/rules.test.js` (92 checks: set, deal determinism, opener, legality and every reason code, draw
rules, blocked/domino scoring, match end reasons, ranking, serialization, hash stability, replay, fuzzed commands) +
`tests/content.test.js` (61: content structure, offline validator over all stages, challenges and lessons with a
4000-step bound, AI-vs-AI games for every difficulty pairing, daily determinism) + `tests/server.test.js` (21: hidden
information, membership, duplicate ids, payload cap, turn order, deadlines, replay export). Current result: 174 pass, 0
fail.

`npm run test:e2e` runs 12 steps at 1280x800 and again at 390x844 with touch: title visible; Lesson 1 completes and
chains into Lesson 2; practice setup starts a 3-seat table; pass-and-play hands the seat between two humans; journey
list has 40 stages with stage 1 unlocked; a full journey match is played to the results overlay through on-screen
controls; breakdown rows exist; retry restarts; pause/resume; leave; settings toggles apply. Any console error or page
error fails the run. `npm run test:browser` is the older CDP driver (hard-coded ports 8571/9223, 38 checks).

QA bar, as checkable statements:

- Every mode on the title screen is reachable and finishes at the results overlay by clicking visible controls.
- No console errors or warnings on load, in play, or in settings, with or without WebGL.
- Nothing is cut off at 1280x800, 390x844 portrait and 844x390 landscape: hand tray, end caps, Draw/Pass, pause
  button, banner, overlay buttons all visible without page scroll.
- A new player is guided: Play opens Lesson 1 for a fresh profile; unplayable tiles dim; every rejection is worded.
- `node --check` passes on every `.js`/`.mjs`; the asset audit passes (favicon links resolve, every clip is
  referenced in source, `manifest.json` matches the clips on disk, clips are 48 kHz mono Opus).

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280x720, 66 KB) | Title backdrop, base of the cover | FLUX.2 klein, 1536x864, seed 7501, 28 steps | Generated in this pass, wired (`#title-art`) |
| `assets/results-win.webp` (960x540, 39 KB) | Results overlay art on a win or completed lesson | FLUX.2 klein, 1024x576, seed 7502 | Generated in this pass, wired (`#results-art`) |
| `assets/results-over.webp` (960x540, 36 KB) | Results overlay art on a loss, tie or time-out | FLUX.2 klein, 1024x576, seed 7503 | Generated in this pass, wired |
| `coverart.png` (1200x675, 256-colour, 371 KB) | Store cover | Key art + title/tagline overlay (ffmpeg drawtext) | Replaced in this pass (previous file was a generic template) |
| `icon.png` (256x256), `favicon.svg` | Touch icon, tab icon | Authored (domino glyph) | Shipped |
| `sfx/*.opus` × 36 (see §9) | Event one-shots | MOSS-SoundEffect v2.0, 100 steps | Shipped |
| `sfx/turn-you.opus`, `sfx/table-blocked.opus`, `sfx/match-lose.opus` | New cues for the human's turn, a blocked table, a lost match | MOSS-SoundEffect v2.0, 100 steps, seeds from the generator's name hash | Generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding / generator input / generated table | This pass | Shipped |
| Tiles, felt, wood, cup, steam, sugar cubes | Scene geometry and textures | Procedural in `render3d.js` | Shipped; no 3D model files by design |
| Character animation | — | — | Not applicable (no humanoid) |

## 16. Known limitations

- No text localization layer; English only (§10).
- Hosted play has no client transport: "Create private invitation" and "Find public match" only post to the host API;
  two browsers cannot yet drive one `server.js` session from this repo. Pass-and-play is the offline substitute.
- `server.js` keeps sessions in an unbounded `Map`; eviction is left to the host (`knownissues.md`).
- Cloud-save conflict detection is a timestamp heuristic (remote strictly newer), not a true descendant check.
- Achievements are local; the platform achievement endpoint is not called.
- The 3D layer has no DOM projection of tile labels (`project` / `tileScreenPos` exist but are unused), so the canvas
  is decorative for assistive tech; the DOM mirror is the accessible surface.
- Settings `holdToConfirm`, `cameraPreset`, and the `navUp`/`navDown` bindings are stored and listed but have no
  effect; `ruleset.spinners` is unused.
- `tests/browser.test.js` uses fixed ports 8571/9223 and overwrites `tests/shots/*.png`.
- `masteryXP` accumulates but is not displayed.
- Combo layers key off wall-clock spacing of plays, so "Skip anim" bursts trigger the cascade cue.

## Design intent not yet implemented

- Localization into en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT with a string table, language
  chosen from the host profile or `navigator.language`, and per-locale lesson/stage copy.
- A real hosted lobby: invitation inbox, readiness, reconnect snapshot from `getSnapshot`, and gameplay WebSocket
  events feeding `Session` as the second seat.
- Server-side achievement unlocks and rating changes.
- Hold-to-confirm placement and vertical hand navigation for the stored bindings.
- Projected DOM labels over 3D tiles so the canvas and the mirror share one layout model.
