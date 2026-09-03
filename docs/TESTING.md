# Testing

## Commands

```bash
npm run check          # typecheck + all unit/fixture tests (minimum gate)
npm test               # vitest run
node tools/smoke.mjs   # Playwright browser smoke (build first: npm run build)
npm run build          # typecheck + production build
```

CI runs all of the above on every push to main (see `.github/workflows`).

## Test pyramid

- **Unit** (`tests/blueprint.test.ts`, `power.test.ts`, `defeat.test.ts`,
  `protocol.test.ts`): canonical hashing, budget/graph validation, power paths,
  wire trips, defeat logic, envelope validation, NaN rejection.
- **Physics fixtures** (`tests/physics.test.ts`, deterministic, seeded):
  - cart accelerates via power → motor → wheel → traction
  - unwheeled box never moves under throttle (no hidden drivetrain)
  - empty battery stops the cart but never marks it destroyed
  - welds break under sustained heavy impacts
  - same blueprint + seed → identical spawn checksum
  - 600 ticks without NaN in any transform/velocity
  - simulation never mutates blueprint hash (no runtime leakage)
- **Browser smoke** (`tools/smoke.mjs`): boot → menu → build (place, undo,
  redo) → Test Bay start/end blueprint identity → lock-in → combat vs AI →
  result. Fails on any console error.

## Release gates (non-negotiable)

1. End Test restores a blueprint hash identical to Start Test after any test run.
2. No NaN/Infinity reaches transforms, velocities, heat, damage, or payloads.
3. Same blueprint + seed + inputs replays without catastrophic divergence.
4. Joining with an incompatible protocol version fails clearly before blueprint
   exchange.
5. Neither client can change frozen settings or exceed budget/part limits.
6. No client bundle contains credentials.
7. All gameplay actions are remappable; nothing trapped on a hard-coded key.

## Multiplayer test plan (manual while CI is single-engine)

- `wrangler dev` + two browser profiles: create/join, settings sync, deadline,
  lock-in, countdown, input forwarding, authority snapshots, disconnect grace,
  version mismatch rejection, `/lobbies` listing.
- Artificial latency (devtools throttling): 50/100/200 ms RTT sanity of input
  frames + snapshot corrections.
