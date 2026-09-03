# AGENTS.md — Scrap and Steel

Instructions for coding agents working in this repository.

## What this is

Browser-first physics robot-building sandbox + 1v1 arena fighter.
TypeScript + Vite + Three.js + Rapier 3D on the client; Cloudflare Worker +
Durable Objects as a thin multiplayer relay. Static client on GitHub Pages.

## Commands

```bash
npm run dev        # vite dev server (localhost:5180)
npm run check      # typecheck + unit tests (minimum gate for every change)
npm run build      # typecheck + production build to dist/
npm test           # vitest (unit + deterministic physics fixtures)
node tools/smoke.mjs  # Playwright browser smoke (requires `npm run build` first)
npm run deploy:worker # wrangler deploy (requires scoped CLOUDFLARE_API_TOKEN)
```

## Architecture invariants (non-negotiable)

1. **Blueprints are immutable source data.** No runtime value (temperature,
   charge, damage, velocity, health) may ever be written into blueprint data.
   Simulation reads blueprints; it never mutates them. Test Bay reset depends on
   this. Do not implement reset by "repairing" parts.
2. **Fixed 60 Hz simulation.** Never tie simulation speed to render frame rate.
   All authoritative randomness goes through seeded PRNGs (`makeRng`) — no
   `Math.random()` in match logic.
3. **Physics engine stays behind `src/sim/adapter.ts`.** Do not import Rapier
   types outside the adapter except through type re-exports.
4. **No hidden connections.** Power flows only through explicit wires; wheels
   drive only when placed against a motor; control comes only from bindings.
   Editor templates may map controls but never create power or structure.
5. **Battery depletion is not destruction.** Defeat is physical incapacity of
   both mobility and offense, evaluated from the surviving assembly graph,
   confirmed continuously for 3 seconds. `src/sim/defeat.ts` owns this.
6. **The Room DO never runs physics.** It is a validated relay + match-state
   authority. High-frequency simulation lives in the browsers.
7. **Protocol messages are validated centrally** (`shared/protocol.ts` on the
   client, mirrored checks in `worker/`). Unknown types are ignored; malformed
   payloads never reach simulation code. No NaN/Infinity on the wire.

## Style

- Strict TypeScript. `noUncheckedIndexedAccess` is on — assert deliberately or
  narrow properly.
- One concern per module; keep files under ~500 lines where practical.
- Balance numbers live in `src/content/parts.ts` (data), never hardcoded in sim.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `perf:`, `refactor:`).

## Testing rules

- Physics change → add or update a deterministic fixture in `tests/physics.test.ts`.
- Networking change → malformed-message and reconnect-path tests.
- Blueprint schema change → canonical-hash fixture + migration function; never
  silently mutate old saves.
- UI change → extend `tools/smoke.mjs` before merging.

## Forbidden

- Never read, print, commit, or depend on `~/special.special` or any credential.
  Client bundles must contain no secrets. CI uses scoped GitHub Actions secrets.
- No AI attribution in commits.
- No TODO markers standing in for acceptance criteria.

## Definition of a complete ticket

Changed files + behavior summary + `npm run check` green (and `node tools/smoke.mjs`
for UI/net changes) + no unrelated refactors.
