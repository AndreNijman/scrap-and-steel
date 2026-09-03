# Protocol v1

JSON over WebSocket. Every message is an envelope:

```json
{ "v": 1, "t": "type", "seq": 12, "payload": { ... } }
```

- `v` — protocol version. Mismatch → HTTP 409 on upgrade with
  `{ code: "version_mismatch" }` ("game updated - refresh").
- `t` — message type. Unknown types are ignored safely.
- `seq` — client-assigned monotonic sequence (prevents stale application order).
- Messages > 256 KB are rejected. Payloads must not contain NaN/Infinity.

## Endpoint resolution (client)

1. `?relay=` URL parameter
2. `window.SCRAP_STEEL_RELAY_URL`
3. production: `wss://relay.scrap.andrenijman.com`
4. localhost fallback: `ws://localhost:8787` (dev)

## Client → relay

| type | payload | notes |
|---|---|---|
| `ping` | `{t}` | RTT probe; reply `pong` |
| `set_settings` | partial `BuildSettings` | host only, phase `lobby` only |
| `set_ready` | `{ready}` | both slots ready → build phase starts |
| `lock_blueprint` | `{hash, blueprint}` | phase `build` only; ≤128 KB; DO stores it |
| `input_frame` | `{tick, throttle, steer, fire, lift}` | combat only; throttled to 30 Hz client-side |
| `snapshot` | `{tick, data: number[]}` | authority only; ≤64 KB quantized array |
| `checksum` | `{tick, hash}` | 1 Hz per client |
| `rematch` | `{}` | returns room to build phase (rebuild mode) |

## Relay → client

| type | payload | notes |
|---|---|---|
| `welcome` | `{slot, host, reconnectToken, state}` | reconnect token → sessionStorage |
| `lobby_state` | `{code, phase, settings, players, buildDeadline, result}` | full room snapshot |
| `peer_joined` / `peer_left` | `{slot, name}` | |
| `build_start` | `{deadline, settings}` | **absolute** epoch ms — DO owns the clock |
| `lock_ack` | `{hash}` | |
| `match_countdown` | `{seed, authority, blueprints, arena, combatLimitSec, startAt}` | both blueprints distributed at once |
| `input_frame` | `{slot, tick, throttle, steer, fire, lift}` | forwarded peer input |
| `snapshot` | `{tick, data}` | forwarded authority snapshot |
| `checksum` | `{slot, tick, hash}` | forwarded for divergence detection |
| `peer_disconnected` | `{slot, graceSec}` | 30 s build / 12 s combat grace |
| `peer_reconnected` | `{slot}` | |
| `result` | `{winner, reason, at}` | winner null = draw |
| `error` | `{code, message}` | |
| `pong` | `{t}` | |

## Snapshot format

Flat quantized array: `[tick, perPart: (flag, x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz)]`.
`flag -1` = destroyed part (1 value instead of 13). Positions quantized to mm.

## State machine (Room DO)

```
LOBBY --both ready--> BUILD --deadline absolute--> (force-lock) --> COUNTDOWN (3 s) --> COMBAT
COMBAT --defeat evaluated client-side--> clients send result via checksum path;
DO awards result on: combat deadline (draw) or peer disconnect past grace (win).
RESULT --rematch--> BUILD (rebuild mode: fresh blueprints required)
```

Disconnect: slot is reserved with a reconnect token; combat disconnect past
grace = disconnect loss (no mid-fight authority migration in v1).

## Version gate

Upgrade URL carries `v` (protocol) and `gv` (game version). The Worker rejects
wrong protocol versions before any blueprint exchange.
