# Chain Dominoes

A café-tabletop dominoes game. Match the open ends of the chain, empty your
hand, and keep your remaining pips low when the table locks up. A StarHermit
engine script game (engine 1.19.1): one package, played natively by the
StarHermit client and in browsers by the engine's web runtime. The 3D table
is `starhermit:scene`; every screen, the HUD and the hand of domino tiles are
`starhermit:ui` (the table is never the only way to play).

## Run

```
STARHERMIT=~/sh/runtime/1.19.1/starhermit-1.19.1-linux-x86_64/starhermit
$STARHERMIT .              # play in a window
$STARHERMIT check .        # validate and play 120 frames headless
npm run package            # rewrite the web loader index.html + starhermit-files.json (after every change)
```

## What's inside

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: engine pin, entry, capabilities, controls (`control.*`, `engine.gamepad.*`) |
| `native/main.ts` | Entry: navigation, matches, input, outcomes, lifecycle |
| `native/screens.ts` | Every screen, the HUD, overlays (`starhermit:ui`) |
| `native/render.ts` | The café table (`starhermit:scene`) |
| `native/audio.ts`, `native/platform.ts`, `native/quality.ts`, `native/style.ts`, `native/i18n.ts`, `native/classic.ts` | Sound, save/settings/leaderboards, graphics levels, styles, localization, the classic scripts |
| `js/rules.js` | Pure deterministic rules engine + seeded RNG (shared with `server.js`) |
| `js/content.js` | 6 lessons, 40 journey stages, 8 challenges, daily generator, 5 themes |
| `js/ai.js` | Practice AI: easy / medium / hard, seeded |
| `js/session.js` | Match controller: commands, AI turns, clock, undo, hints, lessons, replay envelope |
| `js/progress.js` | Save document and migration, achievements, the local board |
| `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` | Nine locales |
| `score-script.js` | Platform script posting finished ranked scores to the `high-score` board |
| `server.js` | Authoritative hosted-play Game Script (tested, not packaged) |

## Modes

Learn (six lessons), Journey (40 stages, up to 3 stars each), Daily (one
shared seed per UTC day, ranked), Practice (2–4 players, difficulty, target,
draw rule), Challenges (move limits, speed clocks, closed boneyard, 4-player
tables), Pass & Play (two humans on one device; Hosted Play's invite and
matchmaking lobby when signed in).

## Tests

```
npm test               # unit tests + native checks (tsc, starhermit check, play scripts)
npm run test:browser   # the packaged loader in headless Chrome (desktop, phone, landscape)
npm run plays          # regenerate tests/native/journey-match.play from the rules
npm run css            # tools/ui-style.css → assets/ui-style.json
```

See `spec.md` for the full running spec.
