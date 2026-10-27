// SCRAP AND STEEL — worker/relay.js
// Relay Worker: origin checks, /lobbies listing, WebSocket upgrade routing.
// LobbyRegistry DO: public room summaries + code allocation. Room DO: two-player
// match state machine (LOBBY -> BUILD -> COUNTDOWN -> COMBAT -> RESULT).
// The Room DO is a validated relay + match authority — it never runs 60 Hz physics.
//
//   GET /ping?room=<code>[&shard=<shard>] - where that room runs, { colo, region }
//   websocket /ws?code=<code>[&shard=<shard>&ticket=<t>&dev=<pass>] - that room,
//                or its moved copy (a shard, see room.js); `dev` is a dev pass
//                (netdev.js), checked by the room
// Internal routes between room objects (/_adopt, /_released) are never forwarded.

import { LobbyRegistry } from "./registry.js";
import { Room } from "./room.js";
import { playerWhere, withWhere, shardRegion, roomStub } from "./netplace.js";

// Durable Object classes must be exported from the main module
export { LobbyRegistry, Room };

const PROTOCOL_VERSION = 1;
const ROOM_CODE = /^[A-Z0-9]{4,6}$/; // as the /ws route normalizes it

function allowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || "https://games.andrenijman.com,https://scrap.andrenijman.com";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  const allowed = allowedOrigins(env);
  if (allowed.has(origin)) return true;
  // localhost development origins
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, v: PROTOCOL_VERSION, time: Date.now() });
    }

    // A room's ping target, timed by the waiting room.
    if (url.pathname === "/ping" && request.method === "GET") {
      const code = url.searchParams.get("room") || "";
      const shard = url.searchParams.get("shard") || "";
      if (!ROOM_CODE.test(code) || (shard && !shardRegion(shard))) {
        return json({ error: "bad room", code: "bad_room" }, 400, { "cache-control": "no-store" });
      }
      return roomStub(env.ROOMS, code, shard).fetch("https://room/ping");
    }

    if (url.pathname === "/lobbies") {
      const id = env.REGISTRY.idFromName("global");
      const stub = env.REGISTRY.get(id);
      const resp = await stub.fetch("https://registry/lobbies");
      return resp;
    }

    if (url.pathname === "/ws") {
      const u = url.searchParams;
      const clientVersion = parseInt(u.get("v") || "0", 10);
      if (clientVersion !== PROTOCOL_VERSION) {
        return json({ error: "game updated - refresh", code: "version_mismatch" }, 409);
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "expected websocket upgrade" }, 426);
      }
      if (!originAllowed(request, env)) {
        return json({ error: "origin not allowed" }, 403);
      }

      const create = u.get("create") === "1";
      const code = (u.get("code") || u.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const name = (u.get("name") || "Player").slice(0, 24);
      const reconnectToken = u.get("rt") || null;
      // a moved room's shard, and this player's seat there (room.js)
      const shard = create ? "" : u.get("shard") || "";
      const ticket = (u.get("ticket") || "").replace(/[^a-z0-9]/g, "").slice(0, 16);
      // the join is this query string, so a dev's pass comes with it (room.js verifies it)
      const dev = (u.get("dev") || "").slice(0, 600);
      if (shard && !shardRegion(shard)) return json({ error: "bad shard", code: "bad_room" }, 400);

      let roomCode = code;
      if (create) {
        const regId = env.REGISTRY.idFromName("global");
        const regStub = env.REGISTRY.get(regId);
        const resp = await regStub.fetch("https://registry/allocate", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        roomCode = data.code;
      }
      if (!roomCode || roomCode.length < 4) {
        return json({ error: "missing or invalid room code", code: "bad_room" }, 400);
      }

      // Where the player connects from, for the lag log (request.cf is only
      // reliable here). DEV_TRUST_WHERE (wrangler dev --var) lets tests fake it.
      const where = playerWhere(request, { trustHeaders: env.DEV_TRUST_WHERE === "1" });
      const stub = roomStub(env.ROOMS, roomCode, shard);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/room";
      forwardUrl.search = `?code=${roomCode}&name=${encodeURIComponent(name)}&create=${create ? 1 : 0}${reconnectToken ? `&rt=${encodeURIComponent(reconnectToken)}` : ""}${ticket ? `&ticket=${ticket}` : ""}${dev ? `&dev=${encodeURIComponent(dev)}` : ""}`;
      return stub.fetch(forwardUrl.toString(), withWhere(request, where));
    }

    return json({ error: "not found" }, 404);
  },
};
