# Chain Dominoes — Game Design Document (running spec)

**Status:** shipped, v1.0.0 (`starhermit.txt`), content version 1, on the StarHermit engine 1.17.0. This document describes what the game does today, in
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
| Platforms | A StarHermit engine script game (engine 1.17.0, host API 1.19, `engine.minor=17`): played natively by the StarHermit client and in desktop and mobile browsers by the engine's web runtime from one package, any orientation |
| Rendering | `starhermit:scene` draws the café tabletop (ceramic tiles, felt, props, lights, post effects); `starhermit:ui` draws every screen, the HUD, the chain strip and the hand tray of drawn domino tiles over it. The hand, end caps and action buttons are the always-usable control surface; the 3D table is also tappable |
| Dependencies | None at runtime. Dev: the StarHermit runtime 1.17.0 (`check`, `--render-check`, `package --web`, `css`), TypeScript 5.9, `playwright-core` for the browser check |

### File map

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.17.0`, `engine.minor=17`, capabilities `platform,storage,clipboard`, `control.*` keys and `engine.gamepad.*` buttons for the 14 actions |
| `index.html`, `starhermit-files.json` | The engine's web loader and the package's file index, written by `npm run package` (never edited by hand) |
| `native/main.ts` | Entry: navigation, match start / pause / leave / continue, selection and the command pipeline, the AI timers and match clock on the fixed steps, outcomes, toasts, captions, leaderboard posting, matchmaking, input routing (actions, pointer and touch picking), lifecycle |
| `native/screens.ts` | Every screen, the game HUD (status bar, rails, tutorial banner, chain strip, hand tray), overlays, toasts, captions, drawn glyphs and dominoes |
| `native/render.ts` | The 3D café table: tiles, chain layout, hand, opponents, boneyard, markers, props, steam, lights, reflections, post effects, camera framing / swoop / shake / top view, picking |
| `native/quality.ts` | Graphics tier → look and budgets (the browser build's `js/gfx.js` presets) |
| `native/audio.ts` | Clips per event, the rendered pad and room tone, captions, on the runtime's buses |
| `native/platform.ts` | Save document, foreign-save and settings migration, game settings, player, invite link, leaderboard read and post, matchmaking, platform clock |
| `native/style.ts`, `tools/ui-style.css`, `assets/ui-style.json` | The class-based style sheet (converted with `starhermit css`), theme and colour-vision tokens |
| `native/i18n.ts`, `native/classic.ts` | Locale from the runtime's interface language; the classic `js/*.js` scripts loaded with `loadClassic`, their shapes typed |
| `js/rules.js` | Pure rules engine: tile set, seeded RNG streams, `createMatch`, legality, `applyCommand`, scoring, ranking, hashing, replay. Shared verbatim with `server.js` |
| `js/content.js` | Themes (5), lessons (6), journey stages (40), challenges (8), daily generator, practice config, offline validator |
| `js/ai.js` | `chooseMove(state, seat, difficulty, rng)`: easy / medium / hard, seeded |
| `js/session.js` | `Session`: one match; commands, AI scheduling (on the client's timers), clock (`advanceClock`), undo, hints, lesson step engine, replay envelope, progression, achievements |
| `js/progress.js` | Save document (`normalize`, `mergeDocs`, `fromBrowserSave`), the game's settings and their checks, achievements, the device's local board |
| `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` | Translation tables (`CDM_STRINGS`), the localizer (`CDMI18N`), account lines |
| `score-script.js` | StarHermit platform script: range-checks a finished match score and posts it to the `high-score` leaderboard |
| `server.js` | Authoritative hosted-play Game Script (tested in Node; not packaged, not the deployed script) |
| `sfx/` | 39 Opus clips; `manifest.txt` (canonical binding), `manifest.json` (generator input), `manifest.md` (generated) |
| `assets/` | `key-art.webp` (title backdrop), `results-win.webp`, `results-over.webp`, `ui-style.json` |
| `coverart.png`, `cover.jpg`, `icon.png` | Store cover, platform cover, icon |
| `tests/` | `progress.test.mjs`, `session.test.mjs`, `i18n.test.mjs`, `rules.test.js`, `content.test.js`, `server.test.js` (unit); `native.mjs` with `native/*.play` (engine checks) |
| `tools/` | `package-web.mjs`, `css.mjs`, `gen-play.mjs` (journey-match play script from a simulated match), `browser-play.mjs` (headless Chrome play of the loader) |
| `knownissues.md` | QA history of the browser build |

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
   information: bloom only on the legal-end markers and selection ring, no particles over the chain, a 0.15 shake at round end that reduced motion removes.
   Rules out: strobing, camera swoops the player cannot skip, sounds that fire without a logical event.

## 3. Player experience

**Target player.** Someone who knows or half-remembers dominoes and wants a five-minute table on a phone or a
longer sit-down against tougher AI on a desktop; also the accessibility-first player who needs full keyboard,
screen-reader and reduced-motion support without a lesser game.

**First 60 seconds.** Title shows key art, "Play" and the mode list. A fresh profile pressing Play (`main.ts
quickPlay`) is sent straight into Lesson 1 "Match the Ends": a 2|4 already on the table, two tiles in hand, a banner
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

**Achievements** (`js/progress.js ACHIEVEMENTS`, idempotent): `first_win`, `mechanic_mastery` (all six lessons),
`streak_5`, `milestone_hard` (win a mastery stage numbered ≥ 32), `marathon_100`, `daily_7`, `journey_complete`.

## 6. Controls and interaction

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options (F1), and Settings →
Keyboard & gamepad lists the current keys and opens the rebinding (`requestRebind`).

| Intent | Mouse / touch | Keyboard (default) | Gamepad (default) |
|---|---|---|---|
| Select a hand tile | Tap the tile in the hand tray or its 3D mesh | `←` / `→` (`left` / `right`) select and focus | D-pad / left stick |
| Place on an end | Tap the end cap or the 3D end ring; a second tap on a selected tile with one legal end commits | `A` left end, `D` right end (`end_left` / `end_right`); `Enter` (`confirm`) commits when exactly one end is legal | LB / RB; A |
| Deselect | Tap the table | `Escape` (`cancel`; with nothing selected it pauses) | B |
| Draw / Pass | Buttons (shown only when legal) | `W` / `S` | X draws, LT passes |
| Hint / Undo | Buttons (hidden when not allowed) | `H` / `U` | Y hints, Select undoes |
| Pause | ☰ button | `P` | Start |
| Skip animation | "Skip anim" runs all pending AI turns and settles the scene | — | — |
| Camera | "Top view" toggles a fitted top-down view | `C` resets the authored angle | Right stick press |

Input rules: `Session.act` refuses commands while paused or finished and dedupes by action id; a 3D tap is a press and
release within 12 px (window pixels × scale) over the scene, never over a widget, and a mouse press right after a touch
is ignored. A focused widget handles `Enter` itself; with nothing focused `confirm` commits the selected tile's only
end. Every accepted input plays `ack`, every selection `select`, every rejection `invalid` plus a vibration when
haptics are on. Lower-case action names replace the browser build's (`navLeft` → `left`, `cameraReset` → `camera`,
`endLeft` → `end_left`): bindings players changed in the browser build are not carried over.

## 7. Screens and UI flow

`title → learn | journey | setup(practice · daily · challenges · hosted/pass-and-play) | profile | settings | help → game`.
The game owns overlays (modal `ui.dialog`s): pause (Resume / Settings / How to Play / Leave match; Settings and How to
Play open as screens whose Back returns to the paused table), round (pip totals, points, match score, Next round),
results (heading, results art when the window is taller than 640 px, stars, breakdown, unlocks, leaderboard line, meta
line with reason · rounds · time · seed, Play again / Next stage / Menu; lessons show their outro with Next lesson),
the Table drawer on compact layouts, and the erase confirmation. Escape closes the pause menu and the drawer; the round
and results overlays need an explicit choice; an overlay ignores the press that opened it.

Layouts (by the window's logical size, `native/screens.ts layoutNow`):

- **Wide ≥ 1024 px.** Status bar / Table rail 240 · playfield · Actions rail 220 / hand tray. Table rail: open ends
  (big digits), round and target, boneyard count, draw rule. Actions rail: Draw, Pass, Hint, Undo (with key caps),
  Skip anim, Top view, the turn indicator at the bottom.
- **Compact 601–1023 px.** The Table rail is a drawer (☰ Table button at the playfield's top left); the Actions rail
  is a 64 px column of small wrapping labels with a compact turn indicator.
- **Phone portrait ≤ 600 px.** Status bar (objective ellipsised, score chips scroll when they overflow), playfield,
  an action row (four per line) with the full-width turn indicator, hand tray.
- **Short landscape (≤ 500 px tall).** As compact, with 64 px tall tiles.
- The left-handed setting mirrors the rails and the status bar. The title shows its menu in two columns and a compact
  hero when the window is under 700 px tall; tall screens scroll. The chain strip sits at the playfield's bottom over
  the 3D table (it scrolls sideways when the chain outgrows it), the tutorial banner at its top. Safe areas are the
  runtime's; the player's interface and text size scale everything.

Must never be cut off: the hand tray, the end caps, Draw/Pass, the pause button, the banner text and the overlay
buttons (overlays scroll when taller than the window).

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

**Scene constants** (`native/render.ts`): perspective fov 38 (54 in portrait), camera `[0,26,30]` looking at `[0,0,-2]`,
intro swoop from `[0,40,52]` over 1.4 s cubic ease; table 72 units, felt 56x44; tile 2x4x0.85 with 0.35 gap; chain
rows of 30 units advancing 5.2 per row in a serpentine. ACES filmic tone mapping, exposure 1.05 (Midnight 1.55, Mono
1.2), fog from 70 to 160 in the theme fog colour. Post-processing and effects follow the graphics level below.

**Graphics.** A warm key light with soft shadows fitted to the play area, a hemisphere fill and a café pendant
(three.js intensities ÷ π for the engine's physical lights); ACES filmic tone mapping. Tiles are extruded rounded
rectangles (ceramic, material class per level) with a canvas face per value pair: drilled pips, a grooved divider, a
brass spinner pin; the felt sits in a leather-bound band; the wall has a plaster band over a wainscot and a mullioned
window; the cup has a crema ring and soft steam. The browser build's bump maps (wood, felt fibres, recessed pips) are
normal maps computed from the same height canvases. Detailed levels add the RoomEnvironment reflections (PMREM,
intensity 0.3, the felt 0.08), clearcoat glaze and the window-light shimmer; post effects are the renderer's
(`renderer.ao`, `bloom` with the legal-end markers and selection ring boosted ×3.2 past the threshold, `grade` with the
same S-curve, saturation, split toning and vignette, `antialias`). The graphics level is the runtime's (Options →
Graphics: Auto from the hardware level, the level, render scale, frame-rate limit and readout); `native/quality.ts`
maps its tier to the browser build's presets:

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows / AO / bloom / grade / AA | off / off / off / off / off | 1024 / off / on / on / FXAA | 2048 / on / on / on / SMAA | 4096 / high / on / on / MSAA |
| Reflections, detail, shimmer | off | on | on | on |
| Materials (table, felt, band, wall, cup, tiles) | Lambert | Standard | Physical (clearcoat glaze) | Physical |
| Tile-face texture | 128×256 | 256×512 | 256×512 | 512×1024 |
| Tile corner curve / bevel segments | 3 / 1 | 6 / 2 | 8 / 3 | 12 / 4 |
| Steam points (× 1.64 per level above the tier's first, ≤ 4×; cap 24 low tiers, 480 high) | 16 | 24 | 120 | 200 |

The 3D table draws only in a match (`renderer.camera` is cleared on the menus, which sit on their radial-gradient
backdrop and the title's key art).

**Motion.** Tiles move on a critically damped spring (k = 90); selection lifts 0.9 units and adds a 0.25 emissive
tint plus a grounded ring; end rings pulse ±8 %; steam drifts on the CPU; the round-end shake is 0.15 units decaying.
Reduced motion (the runtime's Options) snaps tiles, skips the intro swoop, stops steam and shake, and
stops the end-cap pulse. "Skip anim" always lands the scene in the exact logical end state.

**Visual assets the design calls for.** Title key art (café table, chain, cup, warm light) behind the menu; two
results illustrations, one for a win and one for a lost or blocked table; a cover image built from the key art.
Tiles, felt, wood, cup and steam stay procedural so every theme recolours them without new files.

## 9. Audio direction

Mix: effects carry the information (every logical event has one short ceramic or wooden transient), ambience is a
low-passed brown-noise café room tone (rendered once into a 4 s cross-faded loop, 0.16), music is a four-chord sine
pad (C, Am, F, G every 3.4 s, rendered clips) while a match is on; both rest while paused. Sounds play on the runtime's
buses — music → `music`, effects and ambience → `effects`, menu cues (hover, modal, tabs, toasts, ticks) →
`interface` — whose volumes, mute and voice limit are the runtime's Options; the old bus levels (music 0.5, effects
0.8, ambience 0.4) are folded into each sound's gain. Clips load one at a time once the mixer runs (in a browser after
the first press); delayed cues are scheduled by mixer time. Successive plays within 2.6 s escalate a combo layer. Each
cue also posts a caption ("tile placed", "table blocked") shown for 1.2 s.

The table below is the source of `sfx/manifest.txt`. Event ids are the `sfx` methods in `native/audio.ts`.

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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings.** English text is the key; `js/strings.js` holds one row per key with es-419, de-DE, fr-FR, pt-BR and
  it-IT; en-GB, es-ES and fr-CA list only their differences. `tr()` falls back regional → parent → English and fills
  `{name}` placeholders; every string is looked up each frame, so a language change shows at once (the match in play
  is untouched). Content names, goals, lesson steps and outros translate at display time; daily names and goals are
  built per locale. Seat names ("You", "Guide", "Player 1/2") translate; opponents' names, "Chain Dominoes" and
  "StarHermit" do not. Account lines come from `js/platform-strings.js`.
- **Language.** The runtime's interface language (`preferences().language`: the player's choice in Options →
  Language, else the account's preferred language, else the device's), mapped to the nearest shipped locale
  (`native/i18n.ts pickLocale`: en-GB/es-ES/fr-CA by region). The game has no language menu of its own.
- `tests/i18n.test.mjs` collects every key from `native/*.ts` (`tr()`, `N()`, captions), the session and the content,
  and fails when a locale lacks one, drops a placeholder, or keeps a key nothing shows. Layouts tolerate longer text:
  labels wrap into paragraphs, the objective ellipsises, screens and overlays scroll.

## 11. Accessibility

- **Keyboard and gamepad.** Every screen is navigable by Tab / arrows / Enter (the runtime's UI focus) and the gamepad
  (D-pad, South, East); in play, arrows select tiles, `A`/`D`/`Enter` place, `W`/`S` draw/pass, `P` pauses,
  `U`/`H` undo/hint, `C` resets the camera. Focus rings are 3 px `#ffd27a`.
- **Screen readers.** The runtime's accessibility tree: hand tiles are buttons labelled "4 | 6 domino, playable",
  chain tiles images "4|6 on the table", end caps "Play selected tile on right end (4)"; the session's announcements
  (lesson steps, turn prompts with the open ends, rejections assertively, results, pass-and-play hand-overs) go
  through `ui.announce`.
- **Captions.** Every meaningful sound shows a caption ("♪ tile placed", a drawn note glyph) for 1.2 s.
- **Contrast and colour.** The runtime's high contrast forces the UI's colours (and hides the title art); three
  colour-vision palettes remap good/bad/accent-2; optional numerals on tiles.
- **Motion and timing.** The runtime's reduced motion snaps tiles, skips the intro swoop and stops steam, shimmer,
  shake and the end-cap pulse; timing assistance gives challenges 1.5× their limit; haptics can be disabled; a
  left-handed layout mirrors the rails. Text size and interface size are the runtime's and scale every layout.
- **Targets.** Buttons ≥ 44 logical px, tiles 44×64–76 with 8 px gaps, end caps 44 px circles.

## 12. StarHermit integration

The runtime owns sign-in, the launch token, Options (audio, graphics, language, controls, accessibility), bug
reports and the account dialog; the game uses `starhermit:platform` and `starhermit:storage`.

| Platform feature | Used | How |
|---|---|---|
| Sign in | Yes | Guests see **Sign in with StarHermit** on the title (`requestSignIn`); a session that ends shows a toast and the title line |
| Identity | Yes | Signed in, the seat name is the account's display name (read-only on Profile); guests name themselves (saved in the save document) |
| Cloud save | Yes | `saves` holds `{ v: 1, profile, progress, savedMatch }` on the device and in the account's slot (`game:<slug>`); conflicts merge (`mergeDocs`: the better of every record, each device's own resumable match). The browser build's save (the JS SDK's `save.json`, checksummed envelope) shows as foreign: merged in, its game settings adopted, replaced once (`replaceForeign`) |
| Settings | Yes | The game's own settings (theme, numbers on tiles, colour-vision palette, left-handed, hold to confirm, timing assistance, haptics, hints, undo) are `settings` keys synced with the account; the browser build's per-player keys are migrated then removed |
| Controls | Yes | 14 actions in `starhermit.txt` (`control.*`, `engine.gamepad.*`), rebound in Options |
| Invite link | Yes | Signed in: **Invite a friend** on the title and Hosted Play copies `inviteLink()` to the clipboard |
| Leaderboards | Yes | `high-score`: signed in, every finished ranked match (Journey, Daily, Challenge) posts its score through `score-script.js` (a practice session's game socket, `{ type: 'result', scores }`); the results show posting / rank. Profile → Global / Daily reads the board's top 20 (guests too, once the board id is known) |
| Matchmaking | Lobby only | "Find public match" joins the game's queues, polls the ticket every 3 s and cancels it on a match, saying hosted tables need the realtime play update |
| Server time | Yes | `serverNow()` dates the daily table (device UTC date offline) |
| Achievements | Local | Seven keys in the save document |
| Telemetry | No | The browser build's consent-gated events (kept in memory only) are not ported |

## 13. Technical architecture

- **Boot.** `native/main.ts` imports `classic.ts` (a `localStorage` shim over device storage, then the `js/*.js`
  scripts via `loadClassic`), registers styles, reads the save and settings, applies the theme and the graphics
  level, and shows the title.
- **Data flow.** Input → `main.ts` → `Session.act(cmd, actionId)` → `rules.applyCommand` → `Session.buildView()` →
  `render.sync(view)` and the immediate-mode UI (which reads the view every frame). AI turns are the session's
  `setTimeout`s on the client's timers, counted in fixed steps (60 a second) while the match is unpaused; the match
  clock advances per fixed step during active play. Play scripts therefore replay exactly.
- **Determinism and replay.** The replay envelope (`version, build, contentVersion, seed, initialHash, startedAt,
  commands[], hashes[], terminal`) is unchanged; décor uses theme-derived streams that never touch rules.
- **Persistence.** Progress and the resumable match are the save; the local board (`chaindominoes.localboard.v1`,
  top 100) and the leaderboard id stay on the device. Leaving a match, hiding the window or quitting keeps the active
  match resumable (Continue Match).
- **Lifecycle.** A hidden window pauses the match and flushes the save; the 3D table draws only in a match.

## 14. Testing and acceptance criteria

`npm test` = unit + native checks:

- `tests/progress.test.mjs` (merges, the browser save and settings migration, achievements, the local board),
  `tests/session.test.mjs` (AI on client timers, pause, the client clock ending a speed challenge, a journey match to
  results), `tests/i18n.test.mjs`, `tests/rules.test.js` (92), `tests/content.test.js` (61), `tests/server.test.js` (21).
- `tests/native.mjs`: the web index matches the files, `tsc` (no `skipLibCheck`), `starhermit check .` with no
  warnings, then every `tests/native/*.play` as a signed-out render check at 960×540: `screens.play` (journey, daily,
  challenges, learn, help, settings toggle, profile naming, pass-and-play), `learn-lesson.play` (lesson 1 to its outro,
  lesson 2's draw and play), `journey-match.play` (stage 1 played to the results, generated by `tools/gen-play.mjs`),
  `practice-actions.play` (3-player practice: hint, arrow selection, top view, drawer, pause → settings → back,
  leave, Continue Match, a speed challenge's clock).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in headless Chrome at 1366×768, 390×844 and
  844×390 — title, Enter into the first lesson, a tile picked by arrow and played with D, a hint, taps, pause — failing
  on console errors or warnings or the runtime's error screen.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280x720, 66 KB) | Title backdrop, base of the cover | FLUX.2 klein, 1536x864, seed 7501, 28 steps | Generated in this pass, wired (`#title-art`) |
| `assets/results-win.webp` (960x540, 39 KB) | Results overlay art on a win or completed lesson | FLUX.2 klein, 1024x576, seed 7502 | Generated in this pass, wired (`#results-art`) |
| `assets/results-over.webp` (960x540, 36 KB) | Results overlay art on a loss, tie or time-out | FLUX.2 klein, 1024x576, seed 7503 | Generated in this pass, wired |
| `coverart.png` (1200x675, 256-colour, 371 KB) | Store cover | Key art + title/tagline overlay (ffmpeg drawtext) | Replaced in this pass (previous file was a generic template) |
| `icon.png` (256x256) | Icon | Authored (domino glyph) | Shipped |
| `sfx/*.opus` × 36 (see §9) | Event one-shots | MOSS-SoundEffect v2.0, 100 steps | Shipped |
| `sfx/turn-you.opus`, `sfx/table-blocked.opus`, `sfx/match-lose.opus` | New cues for the human's turn, a blocked table, a lost match | MOSS-SoundEffect v2.0, 100 steps, seeds from the generator's name hash | Generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding / generator input / generated table | This pass | Shipped |
| Tiles, felt, wood, cup, steam, sugar cubes | Scene geometry and textures | Procedural in `native/render.ts` | Shipped; no 3D model files by design |
| Character animation | — | — | Not applicable (no humanoid) |

## 16. Known limitations

- Hosted play has no client transport: "Find public match" only joins and leaves the queue; two players cannot yet
  drive one `server.js` session. Pass-and-play is the offline substitute.
- `server.js` keeps sessions in an unbounded `Map`; eviction is left to the host (`knownissues.md`).
- Achievements are local; the platform achievement endpoint is not called.
- Settings `holdToConfirm` and the `up`/`down` actions are kept and listed but have no effect; `ruleset.spinners` is
  unused; `masteryXP` accumulates but is not displayed. Journey stage themes are not applied (the table theme is the
  player's setting), as in the browser build; stage 1's goal names an opponent other than the seated one (content text).
- Guests' browser-build local progress and local board (browser `localStorage`) cannot migrate; cloud saves do.
- Combo layers key off mixer-time spacing of plays, so "Skip anim" bursts trigger the cascade cue.

## Design intent not yet implemented

- A real hosted lobby: invitation inbox, readiness, reconnect snapshot from `getSnapshot`, and gameplay WebSocket
  events feeding `Session` as the second seat.
- Server-side achievement unlocks and rating changes.
- Hold-to-confirm placement and vertical hand navigation for the stored bindings.
- Projected DOM labels over 3D tiles so the canvas and the mirror share one layout model.
