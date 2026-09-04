# AGENTS.md — Scrap & Steel (2D)

Instructions for coding agents working in this repository.

## What this is

A 2D side-on mechanical robot engineering sandbox + 1v1 arena fighter.
TypeScript + Vite + Canvas 2D (procedural pixel art) + planck.js physics on the
client; Cloudflare Worker + Durable Objects as a thin multiplayer relay.
Static client on GitHub Pages at scrap.andrenijman.com, relay at
relay.scrap.andrenijman.com.

## Commands

```bash
npm run dev           # vite dev server (localhost:5180)
npm run check         # typecheck + vitest (minimum gate for every change)
npm run build         # typecheck + production build to dist/
npm test              # vitest
node tools/smoke.mjs  # Playwright browser smoke (requires npm run build first)
node tools/mp-smoke.mjs     # relay protocol smoke against wrangler dev
node tools/prod-e2e.mjs     # two-browser online match on the live relay
npm run deploy:worker # wrangler deploy (scoped CLOUDFLARE_API_TOKEN)
```

## Architecture invariants (non-negotiable)

1. **Blueprints are immutable source data.** No runtime value (heat, charge,
   damage, velocity) may ever be written into blueprint data. Test-mode restore
   depends on it. Never "repair" parts on reset — rebuild the simulation.
2. **Fixed 60 Hz simulation.** Never tie simulation speed to render frame rate.
   Seeded RNG only in match logic; no `Math.random()` in authoritative code.
3. **No hidden connections.** Power flows only through wires the player routed;
   wheels drive only when a motor is adjacent; the robot only moves because the
   player's logic circuit says so. Editor tools may suggest, never auto-connect.
4. **Bots are players.** Bot opponents are plain blueprints plus a driver that
   sets virtual keys. Never give bots stats or information the player cannot
   have.
5. **Battery depletion is not destruction.** Defeat = no mobility AND no
   offense (or no controller), confirmed continuously for 3 s.
   `src/game/sim.ts` owns this.
6. **The Room DO never runs physics.** It is a validated relay + match-state
   authority with storage-backed state, attachments and alarms (hibernation
   safe). All simulation lives in the browsers.
7. **Protocol messages are validated centrally.** Unknown types ignored,
   malformed payloads never reach the sim, no NaN/Infinity on the wire.
8. **All sprites are procedural.** No binary art assets; `src/render/sprites.ts`
   paints every part pixel by pixel.

## Style

- Strict TypeScript; `noUncheckedIndexedAccess` is on.
- One concern per module; files under ~500 lines where practical.
- Balance numbers live in `src/game/parts.ts` (data), never hardcoded in sim.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).

## Testing rules

- Physics change → fixture in `tests/physics.test.ts` (drive, no-hidden-
  drivetrain, empty-battery, NaN gate).
- Logic change → `tests/logic.test.ts`. Power change → `tests/electric.test.ts`.
- Blueprint change → canonical-hash fixture in `tests/blueprint.test.ts`.
- UI change → extend `tools/smoke.mjs` before merging.
- Relay change → `tools/mp-smoke.mjs` + hibernation scenario, then
  `tools/prod-e2e.mjs` against production.

## Forbidden

- Never read, print, commit, or depend on `~/special.special` or any credential.
- No secrets in client bundles. CI uses scoped GitHub Actions secrets.
- No AI attribution in commits. No TODO markers standing in for acceptance
  criteria.

## Definition of a complete ticket

Changed files + behavior summary + `npm run check` green (+ smoke for UI/net
changes) + no unrelated refactors.
