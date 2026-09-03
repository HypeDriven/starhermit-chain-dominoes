# Known Issues — Chain Dominoes

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and browser integration test.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/rules.test.js`, `tests/content.test.js`, `tests/server.test.js`) | 92 + 61 + 21 = 174 pass, 0 fail |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.js`) |
| `npm run test:browser` (`tests/browser.test.js`, headless Chrome via raw CDP) | PASS — 38 pass, 0 fail |

Note: this game has no HTTP `server.js` — `server.js` is the hosted Game Script (createSession /
submitCommand / getSnapshot / tick / endSession). The browser test starts its own static server on its
hard-coded port 8571 and drives its own Chrome on CDP port 9223, so it could not be moved into the
assigned port range; it was run as shipped.

Re-run 2026-08-26 after the fixes below and the sfx/ wiring: `npm test` 174 pass / 0 fail,
`npm run test:browser` 38 pass / 0 fail, `node --check` clean on all changed files.

## Confirmed defects

Defect 2 was reproduced by driving a real two-player session through the shipped Game Script API.

**Update 2026-08-26:** both confirmed defects fixed (see notes inline). Suspected #1 and #3 also fixed;
suspected #2 (session map bounds) left as-is — lifecycle ownership belongs to the host.

### 1. `createCustomState` throws when an authored setup has an empty chain — **FIXED 2026-08-26**

Fix: `js/rules.js:183` guard is now `if (cfg.chain && cfg.chain.length)`, so an empty authored chain
falls into the `else` branch (`leftEnd = rightEnd = null`). Verified:
`createCustomState({ ..., chain: [] })` now returns a state with null ends instead of throwing.

- **File:** `js/rules.js:178-193` (`createCustomState`), specifically lines 183-186
- **Trigger:** `createCustomState({ seed, players, hands, chain: [] })` — an authored setup that starts
  with no tile played.
- **Behaviour:** `if (cfg.chain)` is true for `[]`, the `forEach` iterates zero times, and the next line
  reads `state.chain[0].left` on an empty array. The `else` branch that correctly sets
  `leftEnd = rightEnd = null` (line 188) is skipped. The guard needs a length check.
- **Expected:** an authored setup with an empty chain is the natural way to express "no tile played yet",
  and the `else` branch shows it was meant to be supported. spec.md §2 "Difficulty and content
  generation" describes content as versioned data with an explicit initial state.
- **Evidence:**

  ```
  createCustomState(chain: []) THREW: TypeError: Cannot read properties of undefined (reading 'left')
  ```

  Reachability: every shipped tutorial in `js/content.js` supplies a one-tile chain (lines 79, 94, 111,
  126, 139, 153), so no shipped content hits this today. The two call sites are
  `js/session.js:61` and `js/content.js:344`, both of which pass an authored `setup` straight through, so
  any new lesson written with an empty chain crashes at load.

### 2. A session stuck at `round-over` never times out — the deadline is pushed forward forever — **FIXED 2026-08-26**

Fix: `server.js:148` — in a non-active phase, an overdue `tick` now resolves the session
(`session.ended = { reason: 'timeout', terminal: st.terminal || <abandoned terminal> }`) and returns
the ended event, instead of pushing `deadlineAt` forward. Verified by replaying a two-player session to
`round-over`, then ticking past the deadline: first overdue tick returns `{"reason":"timeout",...}` and
later ticks return `null` (session ended).

- **File:** `server.js:143-161` (`tick`), specifically line 148
  (`if (session.state.phase !== 'active') { session.deadlineAt = now + session.turnDeadlineMs; return null; }`)
- **Trigger:** finish a round, then never submit `next-round` (e.g. every client disconnects at the
  results screen).
- **Behaviour:** `tick` is the deadline-enforcement hook — its own comment says "a player who lets the
  clock lapse forfeits". While `phase === 'active'` it correctly ends the match with
  `timeout-forfeit`. But in any non-active phase it *resets* `deadlineAt` instead of resolving, so every
  later `tick` is also too early and returns `null`. The session never ends and is never evicted; the
  forfeit safety net is silently disabled for the whole `round-over` window.
- **Expected:** spec.md §6 "Sessions and transport" — deadlines exist so an abandoned session resolves.
  The active-phase branch shows the intent.
- **Evidence:** a real two-player session played out to the end of a round through `submitCommand`, then
  ticked five times at one-hour intervals well past the 5-second deadline:

  ```
  after 38 commands, phase = round-over
    tick #1 past the deadline -> null | ended: null
    tick #2 past the deadline -> null | ended: null
    tick #3 past the deadline -> null | ended: null
    tick #4 past the deadline -> null | ended: null
    tick #5 past the deadline -> null | ended: null
  session still unresolved after 5 overdue ticks: true
  ```

  For contrast, ticking past the deadline while `phase === 'active'` correctly produces
  `{"reason":"timeout-forfeit","winner":1,...}`.


## Suspected — not confirmed

### 1. `submitCommand` can throw on a command object with a circular reference — **FIXED 2026-08-26**

- **File:** `server.js:97` (`if (cmd && typeof cmd === 'object' && JSON.stringify(cmd).length > 512)`)
- **Concern:** the payload-size guard calls `JSON.stringify` with no `try/catch`, so a self-referencing
  `cmd` throws `TypeError: Converting circular structure to JSON` out of `submitCommand` rather than
  returning `{ ok: false, ... }`. Reproduced directly: `submitCommand('s1','p1','c-circ', circ)` where
  `circ.self = circ` throws.
- **Why unconfirmed:** unreachable across a JSON transport — `JSON.parse` cannot produce a cycle — so it
  only bites a host that builds the command object in-process. Whether that is within the Games API
  contract is a host question.
- **Fix 2026-08-26:** cheap and safe either way — `server.js:97-101` now wraps the `JSON.stringify`
  size check in `try/catch` and returns `{ ok: false, reason: 'malformed-command' }` on a cycle.
  Verified: `submitCommand(..., circ)` no longer throws.

### 2. `sessions` has no cap, TTL, or eviction

- **File:** `server.js:28` (`const sessions = new Map();`) and `server.js:79` (`sessions.set(...)`)
- **Concern:** nothing bounds the map or removes finished sessions, so repeated `createSession` calls
  grow it without limit. Combined with confirmed defect 2, sessions parked at `round-over` are never
  cleaned up either.
- **Why unconfirmed:** in the Games API model the host controls who may call `createSession` and when
  `endSession` runs, so whether the script or the host owns lifecycle is not settled by this file. I did
  not attempt to exhaust memory on a shared machine.
- **Decision 2026-08-26:** left as-is. Bounding/evicting the map is a lifecycle-policy decision owned by
  the host; confirmed defect 2's fix already ensures parked `round-over` sessions resolve on the next
  overdue `tick`, removing the unbounded-growth amplifier.

### 3. A round that ends via the draw-then-auto-pass path does not set `event.roundOver` — **FIXED 2026-08-26**

- **File:** `js/rules.js:327-345` (`doDraw`), compared with `js/rules.js:347-354` (`doPass`) and
  `js/rules.js:322` (`doPlay`)
- **Concern:** under `ruleset.drawRule === 'one'`, when the drawn tile is still unplayable the code
  records a pass and calls `checkBlockedOrAdvance(state)` (line 342), which can end the round via
  `endRound(state, 'blocked', null)`. Unlike `doPass`, it never sets `event.roundOver = true`, so a caller
  that keys off that flag misses the transition.
- **Why unconfirmed:** nothing in `js/` reads `event.roundOver` — the only consumer is
  `tests/rules.test.js:142`. Callers can and do read `state.phase` instead, so I could not show a
  user-visible consequence.
- **Fix 2026-08-26:** the inconsistency with `doPass` was real and the fix is one line —
  `js/rules.js:344` now sets `event.roundOver = true` when `checkBlockedOrAdvance` ended the round
  (mirrors `doPass`). Verified with a scripted two-draw blocked round: the draw event now carries
  `roundOver: true`.

## Checked, no defects found

- `js/rules.js:433-439` (`nextRound`) — reviewed as a suspected "every round deals the same tiles" bug
  and **disproved**: `startRound` writes the advanced generator state back with
  `state.rng = rng.state()` (`js/rules.js:146`), so `mulberry32(state.rng)` continues the stream.
  Empirically, four consecutive rounds from one match produced four distinct deals.
- `js/rules.js:17-54` — FNV-1a hash, mulberry32, and the named `rules`/`decor`/`av` streams derived from
  one master seed.
- `js/rules.js:126-148` (`startRound`) — Fisher-Yates over the tile ids using the rules stream, hand size
  by player count, boneyard remainder, opening player by highest double then highest pip.
- `js/rules.js:195-325` — legality and `invalidReason` for play/draw/pass, `playableEnds` end-matching,
  and `doPlay`'s left/right placement plus end recomputation.
- `js/rules.js:449-459` (`stateHash`/`stableStringify`) — sorted-key canonical stringify over a shallow
  clone with `log` removed. The shallow clone is safe because `stableStringify` is synchronous and
  read-only.
- `js/ai.js` — the AI reads only `state.hands[p]` (its own hand, lines 18 and 39), the chain ends, and
  `state.lastAction`; it never touches another player's hand or the boneyard contents, and it mutates
  nothing. Difficulty routing (random / top-N / best) is well formed.
- `server.js:30-58` (`publicView`) — other players are exposed only as `handCount`; `yourHand` is gated on
  the requester's index; the boneyard is exposed only as `boneyardCount`, so the deterministic draw order
  is not leaked.
- `server.js:87-121` (`submitCommand`) — session existence, membership, connection state, command-id
  shape and length, idempotent duplicate rejection, and a 512-byte payload cap, all before the rules
  engine is consulted. Malformed commands are also handled cleanly rather than crashing:
  `null`, `undefined`, `42`, `"str"`, `[]`, `{}` all come back as `{"ok":false,"reason":"malformed-command"}`
  and `{"type":"nope"}` as `unknown-command`, because `invalidReason` (`js/rules.js:236-241`) guards
  `!cmd || typeof cmd.type !== 'string'` before anything is dereferenced.

## Not tested

- Hosted multi-client play beyond the single-process Game Script contract exercised by
  `tests/server.test.js`; there is no transport layer in this repo to drive two real clients.
- Audio output (`js/audio.js`).
- Reconnect/turn-deadline behaviour under real network conditions (`tick`/`deadlineAt` are exercised
  synchronously by the unit tests only).

## Runtime artefacts

Running the shipped `npm run test:browser` overwrote the checked-in screenshots
`tests/shots/daily.png`, `game-start.png`, `pause.png`, `results.png` and `tutorial.png` — that is what
the test is written to do. No source file was modified.
