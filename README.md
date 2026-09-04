# SCRAP & STEEL

**Build it. Wire it. Program it. Fight it.**

A 2D side-on mechanical robot engineering sandbox and 1v1 arena fighter for the
browser. Assemble machines on a precise grid from 100+ industrial components,
**wire their power networks by hand**, **program their behaviour with visual
logic circuits**, then test them under real 2D physics — and fight them against
bot opponents or another human online.

**Play:** https://scrap.andrenijman.com

## The philosophy

The game never builds the robot for you:

- Motors do nothing until **you** wire them to a power source.
- Wheels do nothing until a motor sits against them.
- The robot does not know how to drive — **you** build the drive mixer from
  logic nodes (`INPUT FORWARD − INPUT REVERSE → MOTOR POWER`).
- Weapons are assemblies: breech + barrel + ammunition box + trigger logic.
- A railgun is useless without capacitor banks and a serious generator.
- An empty battery is not death — a robot only falls when it physically cannot
  move **and** cannot attack, for three straight seconds.

## Features

- **100+ parts** across STRUCTURE, ARMOUR, MOTION, ELECTRICAL, CONTROL,
  SENSORS, WEAPONS, UTILITY, HYDRAULICS — each with mass, health, cost,
  armour factor and real electrical ports.
- **Grid construction** with snap, rotate, copy/paste, multi-select, undo/redo,
  wire mode with port markers, and an engineering checklist before battle.
- **Electrical simulation**: batteries, generators, capacitors, fuses, breakers,
  distribution boards, bus bars. Overloads trip fuses; greedy motors sag the
  bus voltage; wires heat and burn out; batteries drain.
- **Visual logic programming**: inputs (keys + wired sensors), math, logic,
  timers/latches/PID, outputs bound to specific motors, servos, pistons and
  weapons. Build tank mixes, auto-aim turrets, battery management — anything.
- **2D physics** (planck.js): per-part rigid bodies, breakable welds, powered
  wheels and track units, spinning weapon discs, hydraulic/pneumatic pistons,
  per-part damage with debris, ammo-rack explosions.
- **Workshop test mode**: snapshot the blueprint, run it, break it, restore it
  exactly. Diagnostics overlay with live per-component readouts and power-path
  tracing.
- **Bot opponents built from real blueprints** — SCOUT, TANK, BERSERKER,
  ARTILLERY, EXPERIMENTAL — that set virtual keys through the exact same logic
  circuits as the player. Difficulty scales decisions, never stats.
- **Online 1v1** over a Cloudflare Worker + Durable Objects relay: room codes,
  lobby listing, server-owned build deadline, blueprint lock-in, match seeds,
  input forwarding and authority snapshots, reconnect grace, rematch.

## Stack

TypeScript · Vite · Canvas 2D pixel-art renderer (all sprites drawn
procedurally — zero image assets) · planck.js physics · Web Audio synthesized
sound · Cloudflare Workers + Durable Objects relay · GitHub Pages hosting.

## Development

```bash
npm install
npm run dev          # localhost:5180
npm run check        # typecheck + tests
npm run build        # production build
node tools/smoke.mjs # browser smoke test (after build)
node tools/mp-smoke.mjs          # relay protocol smoke (needs wrangler dev)
node tools/prod-e2e.mjs          # two-browser online match on the live relay
```

Solo play works fully offline. Online needs the relay (`npx wrangler dev`, or
the production relay — endpoints auto-resolve).

## Controls

| Action | Keys |
|---|---|
| Drive forward / back | W / S |
| Fire weapon | SPACE |
| Aux (pistons, hoppers) | SHIFT |
| Turret axis | Q / E |
| Place / select / wire / remove tools | 1 / 2 / 3 / 4 |
| Rotate · delete · copy · paste | R · X · C · V |
| Undo / redo | CTRL+Z / CTRL+Y |
| Test toggle · diagnostics | T · D |
| Zoom / pan | wheel · drag |

All gameplay keys flow through the logic system — the defaults are just the
virtual keys the INPUT nodes read.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Testing & release gates](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

Agent instructions live in [AGENTS.md](AGENTS.md).
