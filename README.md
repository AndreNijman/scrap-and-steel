# Scrap and Steel

Build it. Wire it. Bind it. Fight it.

A physics-based robot-building sandbox and 1v1 arena fighter for the browser.
Assemble a robot from a modular parts catalog, wire its power grid, bind its
controls, test it with real physics — then find out exactly why it survives or
fails in the arena.

**Play:** https://scrap.andrenijman.com

## Highlights

- **Explicit engineering, no hidden auto-connections.** Power flows only
  through wires you route; wheels drive only against motors; weapons fire only
  when bound and powered.
- **Real consequences instead of stat checks.** Mass, center of gravity,
  traction limits, joint stress, heat and battery capacity decide fights —
  there is no hidden health bar and no anti-armor debuff.
- **Battery depletion is not death.** A robot dies only when it physically
  can no longer move *and* cannot attack, for 3 straight seconds.
- **Test Bay.** Snapshot your build, run it against the arena, end test — your
  blueprint is restored exactly, every time.
- **Online 1v1** over a thin Cloudflare relay (Worker + Durable Objects):
  room codes, lobby listing, host-controlled build timer enforced server-side,
  authority snapshots + checksums, reconnect grace.

## Stack

TypeScript · Vite · Three.js · Rapier 3D (WASM) on the client;
Cloudflare Workers + Durable Objects for the relay; GitHub Pages hosting.

## Development

```bash
npm install
npm run dev          # localhost:5180
npm run check        # typecheck + tests
npm run build        # production build
node tools/smoke.mjs # browser smoke test (after build)
```

Solo play works fully offline. Online needs the relay (`wrangler dev` in this
repo, or the production relay — the client auto-resolves endpoints; see
`docs/DEPLOYMENT.md`).

## Controls (remappable)

| Action | Default |
|---|---|
| Throttle | W / S |
| Steer | A / D |
| Fire weapon | Space |
| Lifter | Shift |
| Editor: rotate ghost | R |
| Editor: delete / duplicate | X / Ctrl+D |
| Editor: undo / redo | Ctrl+Z / Ctrl+Y |
| Debug overlay | ` (backtick) |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol](docs/PROTOCOL.md)
- [Physics model](docs/PHYSICS.md)
- [Balance](docs/BALANCE.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

Agent instructions live in [AGENTS.md](AGENTS.md).
