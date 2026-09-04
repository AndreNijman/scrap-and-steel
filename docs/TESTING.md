# Testing & release gates

## Commands

```bash
npm run check          # typecheck + all tests (minimum gate)
node tools/smoke.mjs   # browser smoke (build first)
node tools/mp-smoke.mjs [wsUrl]  # relay protocol smoke
node tools/prod-e2e.mjs [siteUrl]  # two-browser online match on the live relay
```

## Test pyramid

- **blueprint.test.ts** — canonical hashing, adjacency detection, robot stats,
  preflight checklist (missing controller, mass overload).
- **logic.test.ts** — tank-drive mix, sensor comparators driving weapon
  triggers, PID, toggle rising-edge semantics.
- **electric.test.ts** — wired/unwired loads, voltage sag + battery drain,
  fuse trip/reset, severed wires.
- **physics.test.ts** — deterministic fixtures: wired cart accelerates via
  player logic; unwired motor never moves (no hidden connections); spawn
  settling never destroys parts; **empty battery never disables a robot with
  intact hardware**; 600-tick NaN gate.
- **smoke.mjs** — boots the real build: workshop, UI part placement, cart
  assembly (parts + wires + logic), TEST drive, bot battle to resolution.

## Release gates

1. Test-mode restore reproduces the exact pre-test blueprint.
2. No NaN/Infinity reaches transforms, velocities or the wire.
3. No hidden drivetrain: an unwired motor never moves anything.
4. Battery depletion never disables hardware-intact robots.
5. Joining with an incompatible protocol version fails clearly.
6. No credentials in client bundles; CI secret-scans.
7. Online: two browsers complete create → join → build → lock → synchronized
   combat on the production relay (prod-e2e).

## Known simplifications (v1)

- Sensor data does not need physical data wires — sensors need POWER, logic
  nodes reference them directly.
- Ammo boxes feed any wired weapon on the robot (not per-breech feeds).
- Turret bearings rotate the parts welded above them; aim by PID on radar
  bearing or the Q/E turret keys.
