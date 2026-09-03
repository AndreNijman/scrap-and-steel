// SCRAP AND STEEL — worker/relay.js
// Relay Worker: origin checks, /lobbies listing, WebSocket upgrade routing.
// LobbyRegistry DO: public room summaries + code allocation. Room DO: two-player
// match state machine (LOBBY -> BUILD -> COUNTDOWN -> COMBAT -> RESULT).
// The Room DO is a validated relay + match authority — it never runs 60 Hz physics.

import { LobbyRegistry } from "./registry.js";
import { Room } from "./room.js";

// Durable Object classes must be exported from the main module
export { LobbyRegistry, Room };

const PROTOCOL_VERSION = 1;

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

      const roomId = env.ROOMS.idFromName(roomCode);
      const roomStub = env.ROOMS.get(roomId);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/room";
      forwardUrl.search = `?code=${roomCode}&name=${encodeURIComponent(name)}&create=${create ? 1 : 0}${reconnectToken ? `&rt=${encodeURIComponent(reconnectToken)}` : ""}`;
      return roomStub.fetch(forwardUrl.toString(), request);
    }

    return json({ error: "not found" }, 404);
  },
};
