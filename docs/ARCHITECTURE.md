# Architecture

## Layers (strict boundaries)

```
src/app/       boot, screen state machine, HUD, game loop glue
src/editor/    Build Room: place/select/wire/delete/rotate, undo/redo, budget, autosave
src/blueprint/ immutable schema, canonicalization + hashing, migrations, preflight
src/sim/       PhysicsAdapter (Rapier), assembly spawn, power solver, damage, heat, defeat
src/control/   input mapping (remappable), keybind persistence
src/combat/    AI bot blueprint + controller (data-driven builds)
src/net/       relay client, endpoint resolution
src/render/    Three.js scene; reads simulation, never writes it
src/content/   part definitions, arenas, balance numbers (DATA ONLY)
worker/        Relay Worker + LobbyRegistry DO + Room DO (JS, no build step)
shared/        protocol envelope + validation used by the client (mirrored in worker/)
```

Dependency direction: `app → editor/net/combat → sim/blueprint → content`.
`render` and `sim` never import each other; the game loop copies state across.

## Source-of-truth rules

- **Blueprint** = immutable build description (parts, wires, bindings).
  Canonicalized + hashed (`src/blueprint/canonical.ts`). Two equivalent
  blueprints always produce the same hash. Schema version 1; every future
  version gets a migration function + golden fixture.
- **Simulation state** = bodies, HP, temperature, charge, weld integrity. Owned
  by `MatchSimulation`, recreated from a blueprint snapshot at any time.
- **Room state** (multiplayer) = phase, absolute build deadline, seed, lock
  state. Owned by the Room Durable Object. Clients cannot pause or drift the
  clock.

## Rendering vs simulation

The render loop (rAF) steps the simulation on a fixed-timestep accumulator
(60 Hz, max 5 catch-up steps) and copies body transforms into Three.js meshes.
Simulation never waits on rendering; rendering quality degrades before
simulation does (quality tiers).

## Match flow

```
MENU → (solo) BUILD → COUNTDOWN → COMBAT → RESULT
     → (online) LOBBY → BUILD (DO-owned deadline) → LOCKED → COUNTDOWN → COMBAT → RESULT
Test Bay is a sub-mode of BUILD: snapshot blueprint → fresh world → restore snapshot.
```

## Multiplayer topology

- GitHub Pages serves the static client.
- `relay.scrap.andrenijman.com` (Cloudflare Worker) validates origin + version,
  routes `?create=1` / `?code=XXXX` WebSocket upgrades.
- `LobbyRegistry` DO: room-code allocation + public `/lobbies` listing.
- `Room` DO: two slots, settings, absolute deadline, blueprint handoff, match
  seed, reconnect tokens (grace 30 s build / 12 s combat), result. Forwards
  input frames (30 Hz), authority snapshots (10 Hz), checksums (1 Hz).

## Authority model

Slot 0 (host) is correction authority per match (deterministic room policy v1).
Both clients simulate locally for responsiveness; the non-authority client
blends authority snapshots (25% correction per snapshot). Clients exchange
quantized checksums every second; visible desync counter in the debug overlay.
Stale packets are harmless: every match message carries the match seed/instance
and sequence numbers.
