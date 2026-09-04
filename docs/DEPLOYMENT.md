# Deployment

| Artifact | Target |
|---|---|
| Client (Vite `dist/`) | GitHub Pages → scrap.andrenijman.com (CNAME in repo) |
| Relay (`worker/`) | Cloudflare Worker `scrap-and-steel-relay` → relay.scrap.andrenijman.com |

## Client

Push to `main` → Actions: typecheck + tests + build + browser smoke →
upload/deploy Pages artifact. The build embeds the game version.

## Relay

Push touching `worker/**` → Actions deploy with the scoped
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets, followed by a
`/health` + `/lobbies` check. Manual: `npm run deploy:worker`.

- Origin allowlist lives in config (`ALLOWED_ORIGINS`), not secrets.
- The Room DO persists state to storage and uses alarms: deploy-time
  hibernation cannot lose active rooms mid-build.

## Rollback

- Client: revert + push (or re-run a previous Pages workflow).
- Relay: `wrangler rollback`. Protocol version gating means a mismatched
  a mismatched client/relay pair fails instead of corrupting rooms.

## Secrets policy

Scoped Cloudflare API token only. Values stay out of prompts, logs, source and
the client bundle. Rotation requires no code changes.
