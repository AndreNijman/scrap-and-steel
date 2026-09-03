# Physics model

## Engine

Rapier 3D (compat WASM) behind `src/sim/adapter.ts`. Fixed 60 Hz timestep, CCD
enabled only on fast weapon bodies. Engine choice stays reversible via the
adapter.

## Assembly

- One rigid body per part. Mass/inertia from the part definition.
- Adjacent parts (center-to-center face contact in the grid) get a **fixed
  weld joint** with hit-point-independent anchors at the shared interface.
  Weld strength = `min(part hp) × 1.5`.
- **Wheels are never welded.** A wheel touching a motor gets a revolute joint
  (axle = wheel local x); wheels without a motor mount are loose bodies.
- Weapons (spinners) get a revolute joint to their structural mount; saws stay
  welded and act via contact rules.

## Drive

Motorized wheels use a velocity-feedback controller per wheel:
`torque = clamp(err × motor.torque × 0.35, ±motor.torque × derate × thermal)`.
Only 25% of the reaction torque is applied back to the chassis (full reaction
made every build wheelie nonstop; documented simplification). Traction is
emergent from friction — more power beyond grip produces wheelspin, not
acceleration.

## Damage

- Contact force events with `force < 6000 N` never damage (resting/driving
  contact must not grind parts).
- Same-robot contacts between jointed pairs (welds + wheel mounts) never
  damage — solver forces at joint seams are spurious. Detached debris hitting
  its former body still damages.
- Cross-robot contact: base damage `force × 0.008`; a fast weapon body
  (ω > 8 rad/s) replaces this with `force × 0.008 × damageMult × (ω/40)` and
  takes 15% recoil.
- Part hp ≤ 0 → destroyed: welds removed, body stays physical as debris.
- Welds receive 60% of their parts' damage; at 0 the joint breaks (explicit
  breakable connections).

## Heat

Per part: `dT = (gen − cool × (T − 25 °C)) × dt`. Generation scales with power
delivered ÷ requested. Cooling scales with exposure (enclosure factor: sealed
boxes cool worse) plus heatsinks/fans. Derate at 110 °C (50%), shutdown at
145 °C, structural damage above 170 °C.

## Power

Directed wire graph, solved at 15 Hz. Loads request watts; sources (batteries)
have peak output; unregulated paths (no motor controller) deliver 60%. Wires
track **unclamped** demand: drawing more than a wire's rating heats it; at
limit it trips for 4 s (path opens). Battery charge drains by delivered energy.

## Determinism

Same blueprint + seed + input trace replays without catastrophic divergence on
the supported browser matrix (exact bit identity not required; snapshots
correct drift). All match randomness is seeded. No NaN/Infinity may reach
transforms, velocities, heat state, damage state, or network payloads —
enforced by fuzz/fixture tests.

## Debug overlays

Backtick toggles: per-robot mass, charge, power demand/delivery, hottest part,
mobility/offense/control flags, KO timer, desync warnings, authority state.
