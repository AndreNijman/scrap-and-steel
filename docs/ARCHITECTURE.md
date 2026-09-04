# Architecture

## Layout

```
src/main.ts          boot, screens, workshop, battles, HUD glue, game loop
src/game/
  parts.ts           the parts library: ALL balance numbers (data only)
  blueprint.ts       grid build data, canonicalization, adjacency, preflight
  logic.ts           node graph: inputs, sensors, math/flow, outputs, evaluator
  electric.ts        power network: sources, loads, wires, fuses, sag, drain
  physics.ts         planck world build: bodies, welds, wheel/spinner/servo/
                     piston joints, projectiles
  sim.ts             match/test orchestrator: logic -> power -> actuation ->
                     physics -> damage -> heat -> defeat
  bots.ts            bot blueprints + difficulty drivers (virtual keys)
  arena.ts           arenas + physical obstacles
  net.ts             relay client; 2D inputs packed onto the wire protocol
src/render/
  sprites.ts         procedural pixel-art sprite factory (no image assets)
  draw.ts            canvas world renderer, particles, camera
src/ui/logicEditor.ts  bottom-strip node editor canvas
src/audio/sfx.ts     procedural Web Audio sound design
worker/              Relay Worker + LobbyRegistry DO + Room DO (hibernation
                     safe: storage-backed state, attachments, alarms)
shared protocol      mirrored in src/game/net.ts and worker/*.js
```

Dependency direction: `main → builder/logicEditor → sim → physics/electric/
logic → blueprint → parts`. The renderer only reads.

## Source-of-truth rules

- **Blueprint** = grid parts + wires + logic nodes. Canonical string + FNV hash.
  Two equivalent builds produce the same hash. Test mode snapshots the
  blueprint JSON before simulating and restores it verbatim after.
- **Simulation state** = planck bodies, part hp/heat, wire temperatures, fuse
  states, ammo counters. Recreated from a blueprint at will.
- **Room state** (online) = phase, absolute build deadline, locked blueprints,
  match seed: persisted in Room DO storage so hibernation cannot lose a match.

## Tick order (per 1/60 s step)

1. Bot drivers set virtual keys (same path as player keys).
2. Logic graph evaluates → motor powers, servo/piston targets, weapon triggers.
3. Power network solves (15 Hz) → which loads draw power, voltage sag, fuse trips.
4. Actuation: wheel joint motors, track forces, spinner spin-up, servo/piston
   targets, weapon firing (projectiles, ammo decrement, heat).
5. planck step; post-solve impulses → per-part damage (armor-scaled, capped);
   destroyed parts lose their welds and become debris; wires through destroyed
   parts are cut.
6. Heat integrates; overheated parts derate, shut down, then burn.
7. Defeat evaluation (2 Hz): no mobility + no offense (+ no controller), 3 s
   confirmation, double-KO draw.

## Multiplayer

Unchanged relay contract: `?create=1` / `?code=`, settings, absolute build
deadline, lock-in (hash + blueprint), match_countdown (seed + both blueprints),
input_frame (throttle/steer/fire/lift carrying forward-back/aux/fire/turret),
authority snapshots + checksums, disconnect grace, rematch. Authority = slot 0.
The client simulates on its own inputs. The peer's inputs arrive over the wire.
