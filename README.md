# SCRAP & STEEL

Build it. Wire it. Program it. Fight it.

A 2D robot engineering sandbox and 1v1 arena fighter that runs in your browser.
You assemble machines on a grid from over 100 industrial parts. You route the
power cables yourself. You program the robot's behaviour with visual logic
circuits. Then you watch physics judge your work against bot opponents or
another human online.

**Play:** https://scrap.andrenijman.com

## How it works

The game builds nothing for you:

- A motor does nothing until you wire it to a power source.
- A wheel spins only when a motor sits on the same chassis.
- The robot cannot drive until you build the drive mixer from logic nodes:
  INPUT FORWARD minus INPUT REVERSE, into MOTOR POWER.
- Weapons are assemblies. A cannon needs a breech, a barrel, an ammunition box
  and a trigger circuit.
- A railgun needs capacitor banks and a generator that can feed it.
- A dead battery is not a destroyed robot. A robot falls only when it cannot
  move and cannot attack for three straight seconds.

## What you get

- 100+ parts in nine categories: structure, armour, motion, electrical,
  control, sensors, weapons, utility, hydraulics. Each part has mass, health,
  cost, armour value and electrical ports.
- Grid construction with snap, rotate, copy and paste, multi-select, undo,
  wire mode with port markers, and an engineering checklist before battle.
- Electrical simulation: batteries, generators, capacitors, fuses, breakers,
  distribution boards and bus bars. Overloads trip fuses. Hungry motors sag
  the bus voltage. Wires overheat and burn open. Batteries drain.
- Visual logic programming: key and sensor inputs, math, logic gates, timers,
  latches, PID loops, and outputs bound to the exact motor, servo or weapon
  you choose. Build tank mixes, auto-aim turrets, battery management systems.
- 2D physics through planck.js. Each part is its own rigid body. Welds break under
  fire. Wheels, tracks, spinner discs, pistons and turret bearings are real
  joints. Damaged parts fall off as debris. Ammo racks explode.
- Test mode: snapshot the blueprint, run it, break it, restore it unchanged.
  Diagnostics show live current, voltage, temperature and health per part,
  plus the wire path back to the power source.
- Five bot opponents built from real blueprints: SCOUT, TANK, BERSERKER,
  ARTILLERY and EXPERIMENTAL. They set virtual keys through the same logic
  circuits as you. Difficulty changes how they think, not what they have.
- Online 1v1 through a Cloudflare Worker plus Durable Objects relay: room
  codes, a server-owned build clock, blueprint lock-in, input forwarding,
  authority snapshots and reconnect grace.

## Stack

TypeScript, Vite, a Canvas 2D pixel renderer (all sprites drawn in
code, no image assets), planck.js for physics, Web Audio for synthesized sound,
Cloudflare Workers and Durable Objects for the relay, GitHub Pages for
hosting.

## Development

```sh
npm install
npm run dev            # localhost:5180
npm run check          # typecheck + tests
npm run build          # production build
node tools/smoke.mjs   # browser smoke test, after a build
node tools/mp-smoke.mjs  # relay protocol smoke, needs wrangler dev
node tools/prod-e2e.mjs  # two-browser online match on the live relay
```

Solo play works offline. Online play needs the relay: run `npx wrangler dev`
for a local one, or use the production relay. The client picks the endpoint for you.

## Controls

| Action | Keys |
|---|---|
| Drive forward / back | W / S |
| Fire weapon | SPACE |
| Aux (pistons, flippers) | SHIFT |
| Turret axis | Q / E |
| Place / select / wire / remove tools | 1 / 2 / 3 / 4 |
| Rotate, delete, copy, paste | R, X, C, V |
| Undo / redo | CTRL+Z / CTRL+Y |
| Test toggle, diagnostics | T, D |
| Zoom and pan | wheel, drag |

Each gameplay key feeds the logic system as a virtual input. The defaults
above are only key names.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Testing and release gates](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

Agent instructions live in [AGENTS.md](AGENTS.md).

## License

MIT for the code in this repository.
