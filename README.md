# Chain Dominoes

A café-tabletop dominoes game for the browser. Match the open ends of the
chain, empty your hand, and keep your remaining pips low when the table
locks up. Three.js-first presentation with a fully playable semantic HTML
interface layer (the 3D canvas is never the only way to play).

## Run

Any static file server from this directory:

```
python3 -m http.server 8571
# open http://localhost:8571/index.html
```

Everything is local and self-contained (Three.js is vendored in
`vendor/`). No build step, no network dependency.

## What's inside

| Path | Role |
|---|---|
| `index.html` | DOM shell: all screens, overlays, live regions |
| `css/style.css` | Responsive layouts (wide/compact/portrait/landscape), a11y modes |
| `js/rules.js` | Pure deterministic rules engine + seeded RNG (Node-compatible) |
| `js/content.js` | 6 tutorials, 40 journey stages, 8 challenges, daily generator, 5 themes |
| `js/ai.js` | Practice AI: easy / medium / hard, seeded and deterministic |
| `js/session.js` | Match controller: commands, undo, hints, tutorial engine, replay envelope |
| `js/render3d.js` | Three.js café tabletop: authored camera, procedural tiles/props, quality tiers |
| `js/ui.js` | Screens, HUD, DOM mirror controls, keyboard/gamepad input, settings |
| `js/platform.js` | Versioned checksummed saves, achievements, leaderboards, StarHermit adapter |
| `js/audio.js` | Procedural WebAudio: effects, ambience, generative music, 4 buses |
| `server.js` | Authoritative hosted-play Game Script (validated, idempotent, hidden-info safe) |
| `starhermit.txt` | Distribution manifest (`name=Chain Dominoes`, `launch=index.html`, `server=server.js`) |

## Modes

- **Learn** — six interactive lessons; you perform each move yourself.
- **Journey** — 40 authored stages with rising difficulty; mastery tables at
  8/16/24/32/40; up to 3 stars each.
- **Daily** — one shared seed + ruleset per UTC day (ranked: no undo/hints).
- **Practice** — 2–4 players, difficulty, target score, draw rule; unranked
  with undo and hints.
- **Challenge** — move limits, speed targets, closed boneyard, 4-player tables.
- **Hosted play** — private invitations / matchmaking when launched inside a
  StarHermit host shell; offline, pass-and-play on one device. `server.js` is
  the authoritative script: it validates identity, turn order, payload shape,
  and rules legality, and never exposes other players' hands.

## Tests

```
node tests/rules.test.js     # rules engine: legality, scoring, determinism, fuzz
node tests/content.test.js   # offline content validator + AI-vs-AI simulations
node tests/server.test.js    # authoritative session script
node tests/browser.test.js   # end-to-end UI drive via headless Chrome (CDP)
```

The browser test serves the game locally (port 8571) and drives headless
Chrome: real clicks, real moves, pause/resume/undo/skip, tutorial flow,
screenshots in `tests/shots/`.

## Notes

- Determinism: one seed drives independent streams for rules, AI, decor, and
  audio variants; replays verify via periodic state hashes.
- The game is fully playable without WebGL (clear fallback message + DOM
  controls) and fully keyboard/gamepad operable.
- Performance at default tier: ~66 draw calls / ~10k triangles, far under the
  150-call / 350k-triangle budgets.
