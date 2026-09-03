# Deployment

## Topology

| Artifact | Target |
|---|---|
| Client (`dist/` via Vite) | GitHub Pages → `scrap.andrenijman.com` (CNAME in repo) |
| Relay (`worker/`) | Cloudflare Worker `scrap-and-steel-relay` + custom domain `relay.scrap.andrenijman.com` |

## Client (GitHub Pages)

- Push to `main` → Actions workflow builds and deploys `dist/` via
  actions/deploy-pages. The repo has no Pages secrets beyond the default
  OIDC flow.
- The build embeds `GAME_VERSION` (`shared/protocol.ts`); the menu shows it.
- Relay endpoint resolution: `?relay=` override → `window.SCRAP_STEEL_RELAY_URL`
  → production → localhost (dev only). Preview deployments can point at the
  staging relay with `?relay=`.

## Relay (Cloudflare Worker)

Local deploy (scoped token, never the whole secret file):

```bash
CLOUDFLARE_API_TOKEN=$(extracted scoped token) npx wrangler deploy
```

- `wrangler.jsonc` declares the Durable Object migrations (`Room`,
  `LobbyRegistry`) and the custom domain route.
- Origin allowlist: environment/config (`ALLOWED_ORIGINS` var), not a secret.
  Production: `games.andrenijman.com`, `scrap.andrenijman.com`; localhost is
  always allowed for development.
- Health check after deploy: `GET /health`, `GET /lobbies`, then a create/join
  WebSocket handshake.

## Secrets policy

- No secret value ever enters prompts, logs, source, or the client bundle.
- CI deploys use a scoped Cloudflare API token + account id stored as GitHub
  Actions secrets; a local file must never power unattended CI.
- Rotation should not require code changes.

## Rollback

- Client: redeploy a previous commit (`git revert` + push, or re-run a previous
  workflow run).
- Relay: `wrangler rollback` (versioned deployments) — protocol version in the
  gate means a client/relay version mismatch fails cleanly instead of corrupting
  rooms.
- Keep client + relay protocol versions in lockstep; bump `PROTOCOL_VERSION`
  only with a migration path.
