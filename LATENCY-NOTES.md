# SCRAP & STEEL latency notes

## Authority model: (d)-shaped, but not lockstep

Both clients run the whole match simulation (planck physics, power, logic,
damage) from the same seed and both locked blueprints
(src/main.ts:721-731, startOnlineMatch at src/main.ts:755). Nobody is the
authority in practice:

- Each client applies its own input on its own tick at once and the
  opponent's latest input whenever it happens to arrive, held until the next
  one (src/main.ts:732-735, src/main.ts:1358-1365). There is no input delay,
  no tick alignment and no stall: a remote input sent on tick T is applied on
  whatever local tick is current when it lands.
- Inputs go every second sim tick, 30 Hz, stamped with the sender's tick
  (src/main.ts:1359); the relay validates and forwards them to the other slot
  (worker/room.js:315-321).
- "Authority snapshots" exist only on paper. The relay would forward
  `snapshot` from slot 0 (worker/room.js:323-328), but no client ever sends
  one, and the receiving hook `applySnapshotNet` reads the numbers and
  discards them (src/main.ts:737-740, src/main.ts:1550-1568).
  docs/ARCHITECTURE.md ("authority snapshots + checksums") describes intent,
  not code.
- `checksum` is sent once a client's own sim reaches a result
  (src/main.ts:1387), forwarded (worker/room.js:330-335) and ignored by the
  receiver (src/main.ts:741). The relay only uses it to tell "finished" from
  "abandoned" in the lag log.
- Each client shows the result its own sim reached (src/main.ts:1373-1387).
  The relay only decides time-outs and disconnect forfeits
  (worker/room.js:413-471).

So the two sims drift apart under any latency, and the two players can see
different winners. That is a correctness problem older than this work; item 1
does not make it worse and cannot fix it without a netcode rewrite (below).

## What already hides delay

- The local robot is fully local: input to motion never waits for the network
  (src/main.ts:1363).
- The remote robot is dead-reckoned by the local physics with its last known
  input (src/main.ts:1364). That is the only delay hiding, and it is also the
  source of the drift.
- Nothing else: no interpolation, no buffer, no prediction, no correction.

## Rates and message types

- Sim: fixed 60 Hz, up to 5 steps per frame (src/main.ts:1368-1372).
- `input_frame`: 30 Hz per player during combat, relayed to the other slot.
- `ping`/`pong`: 1 Hz per socket from the moment it opens, so pings flow in
  the lobby and during the build phase too (src/game/net.ts:63).
- `lobby_state`, `build_start`, `lock_blueprint`/`lock_ack`,
  `match_countdown`, `result`, `rematch`, `peer_*`: events.
- No server tick loop. The Room DO hibernates between messages; phase
  deadlines and disconnect grace run on storage alarms (worker/room.js:380-471).

## Room lifecycle

- Create: `GET /ws?create=1` asks the LobbyRegistry DO for a 5-character code
  (worker/registry.js:22-64) and opens the Room DO named by that code
  (worker/relay.js). The host is slot 0.
- Join: `GET /ws?code=XXXXX`; two slots, a third gets 409 room_full
  (worker/room.js:194-236). Reconnect by `rt=` token (worker/room.js:196-213).
- Start (match start): when the second player sends `set_ready`,
  `maybeStartBuild()` starts the build phase (worker/room.js:289-295,
  353-356). That is where the lag record starts too (startNetLog,
  worker/room.js:374). The move check (item 4) goes here, before
  `startBuildPhase()`: the build phase is minutes long and nothing in it is
  latency-sensitive, both players are connected and pinging, no blueprint is
  locked yet, so the state to hand over is only settings and the two seats.
- Then build (deadline alarm) -> countdown (3 s, `match_countdown` with seed
  and blueprints) -> combat (deadline alarm) -> result -> rematch goes
  straight back to build (worker/room.js:337-343), which never moves.
- End: both slots empty after their grace -> `cleanup()` (worker/room.js:494).

## Item 1 plan: TIER-2

Per the spec's (d) rule: no rollback in this pass, and there is no fixed input
delay to make adaptive. Smoothing the remote robot (a jitter buffer for remote
inputs) would only move it further from what the other player sees, so it is
not done. No sim or netcode change ships for item 1.

tests/latency/harness.mjs measures the drift as it is: two `Simulation`
instances in Node with scripted inputs, each side's inputs delivered to the
other at 100 ms +-20 ms one way (200 ms RTT +-40) exactly as the client does
today. The "after" line is the same code path.

### Item 1 result

`node_modules/.bin/vite-node tests/latency/harness.mjs` (6 scripted matches,
scrapyard, up to 45 s each, ticks aligned on both sides):

| run | robot position error | ticks the sims disagree on destroyed parts | same winner |
|---|---|---|---|
| control: same inputs, no network | 0.00 m | 0.0% | 6/6 |
| control: 0 ms, 30 Hz input_frame | 2.65 m | 51.1% | 4/6 |
| before: 100 ms +-20 one way | 3.00 m | 55.0% | 6/6 |
| after: no sim change (TIER-2) | 3.00 m | 55.0% | 6/6 |

The sim is deterministic (first control), so the drift is all input timing:
even with no network delay, sending inputs every 2nd tick and applying them on
arrival puts the two players' matches metres apart within seconds, and they
can name different winners. Latency only adds a little on top. Hiding delay
cannot fix this; only lockstep or rollback can. "Same winner 6/6" at 200 ms
is chance: the matches here mostly end in a time-out draw on both sides.

### Rollback estimate

What must snapshot/restore per tick:

- planck world: every body's transform, linear/angular velocity, awake flag;
  every joint's motor speed/torque/force, limits, and the welds destroyed so
  far (destroyPartBody removes joints and bodies, src/game/physics.ts:278);
  projectiles (bodies created and destroyed mid-match,
  src/game/physics.ts:287, sim.ts `projectiles`). planck has no world clone,
  and its contact warm-start impulses live in the contact list: restoring
  positions without them does not replay bit-identically. Realistic options
  are rebuilding the world from a full state record on each rollback, or a
  fork of planck with contact-state save/restore.
- Per robot (src/game/sim.ts:26-52): part hp, heat, ammo, weapon cooldowns,
  motor temperatures, power net state (battery charge, fuse states, wire
  temperatures; solved at 15 Hz), logic runtime (toggles, PID integrators,
  timers), Python store and PID maps (`pyStore`, `pyPid`), capacitor and
  railgun charge, destroyedTimer/defeat counters, partsLost/damageDealt.
- Sim: tick, outcome, the module-level `rngState` (src/game/sim.ts:88;
  currently unused, `void rnd` at :97, but shared across Simulation
  instances, so it must move into the instance first).

Determinism risks: `Math.sin/cos/atan2/exp/pow` are not specified bit-exact
across JS engines (Chrome vs Firefox vs Safari players); Map iteration order is
insertion order, so anything rebuilt on restore must be rebuilt in the same
order; tick-gated logic (defeat at 2 Hz, power at 15 Hz) must key off the
restored tick; user Python runs inside the sim and must be restorable.

Rough effort: rollback 10-15 days (state capture/restore and a determinism
test across browsers are most of it), with real risk around planck contact
state. A cheaper correct step first: delay-based lockstep (apply both
players' inputs at tick T+D, D adaptive from the measured RTT, stall when an
input is missing, start both sims from a relay-synced clock instead of each
client's own Date.now(), src/main.ts:1368), plus comparing the existing
checksums. About 3-5 days; it costs every player D ticks of input delay
(about half the RTT), which is a feel change Andre should decide on.

## Items 2-4: scrap-specific notes

- The Room DO hibernates, so everything the move needs survives in `this.s`
  (storage): each seat's `where` and probes, `moved` (old room), `shard`,
  `movedFrom`, and the adoption tickets and deadline (shard). Recent pings
  stay in memory: the 1 Hz pings keep the object awake, and if it was
  evicted anyway `chooseRegion` gets no ping and the room stays.
- The 6 s adoption wait is an alarm (armDeadlineTimer), so the end-of-alarm
  re-arm from 81fa523 keeps it when a disconnect's 1 s poll replaces it.
- There is no room list in the client (it never calls `/lobbies`), so item 3's
  lobby label is on the waiting-room bar only.

- Limits of the move:
  - Older clients send no `regions`, so a room with one never moves.
  - If only one player reaches the shard within 6 s, the other's seat is
    freed and the room waits in the shard's lobby for a new opponent, as a
    normal room does after a leave; it does not move back.
  - A client that joins the old code after the move gets `move` from
    `sendOnward()`. The socket is closed with 4000 "moved" on its next
    message (the new client closes it itself on `move`; an older client's
    next ping does). Under wrangler dev 4.128 a close from the DO's fetch
    or an alarm never reached the client and an accept()-ed socket closed
    with a timer threw "Network connection lost", so the close waits for a
    message. Worth re-checking on production.
  - The shard object is `ROOMS.idFromName("<code>~<shard>")` with a
    `locationHint`, which Cloudflare treats as a hint: the record's `region`
    is the shard's chosen region, not a measured colo.
- The lobby ping comes from `/ping` (GET, through the relay to the room
  object). The HUD shows the client's last 1 Hz ping sample, so it includes
  any main-thread stall: in the browser smoke on a loaded machine (load 25 on
  16 cores) localhost read 58-142 ms in the lobby and 74-2520 ms in combat.
