// SCRAP AND STEEL — worker/room.js
// Per-room Durable Object. Two-player identity, host/settings authority, absolute
// build deadline, ready/lock state, blueprint handoff, match seed, reconnect tokens,
// WebSocket relay and result state. Uses hibernatable WebSockets.

const PROTOCOL_VERSION = 1;
const BUILD_GRACE_SEC = 30;
const COMBAT_GRACE_SEC = 12;
const MAX_BP_BYTES = 128 * 1024;

function enc(t, payload) {
  return JSON.stringify({ v: PROTOCOL_VERSION, t, payload });
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.slots = [null, null]; // per slot: { name, ws?, token, ready, locked, bp, bpHash, lastSeen }
    this.settings = {
      buildTimeSec: 420,
      budgetSp: 1000,
      partLimit: 120,
      arena: "foundry",
      combatLimitSec: 360,
      rematch: "rebuild",
    };
    this.phase = "lobby"; // lobby | build | countdown | combat | result
    this.buildDeadline = 0; // absolute ms — clients cannot drift the clock
    this.matchSeed = 0;
    this.authority = 0;
    this.result = null;
    this.rematchVotes = new Set();
    this.loadTimer = null;
    this.timeoutTimer = null;
  }

  async ensureRegistryUpdate() {
    if (!this.code || !this.env.REGISTRY) return;
    try {
      const regId = this.env.REGISTRY.idFromName("global");
      const stub = this.env.REGISTRY.get(regId);
      const players = this.slots.filter(Boolean).length;
      await stub.fetch("https://registry/update", {
        method: "POST",
        body: JSON.stringify({
          code: this.code,
          players,
          status: this.phase === "lobby" ? "lobby" : "playing",
          budgetSp: this.settings.budgetSp,
          buildTimeSec: this.settings.buildTimeSec,
          hostName: this.slots[0]?.name || "Player",
        }),
      });
    } catch {
      // registry is best-effort
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/room") {
      const code = url.searchParams.get("code") || "UNSET";
      const name = (url.searchParams.get("name") || "Player").slice(0, 24);
      const isCreate = url.searchParams.get("create") === "1";
      const rt = url.searchParams.get("rt");
      if (!this.code) this.code = code;

      if (typeof Pair === "undefined") {
        // no-op guard for older runtimes
      }
      const pair = new WebSocketPair();
      const ok = await this.handleJoin(pair[1], name, isCreate, rt);
      if (!ok) {
        return new Response(JSON.stringify({ error: "room full", code: "room_full" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  slotOf(ws) {
    return this.slots.findIndex((s) => s && s.ws === ws);
  }

  broadcast(t, payload, exceptSlot = -1) {
    for (let i = 0; i < 2; i++) {
      const s = this.slots[i];
      if (i === exceptSlot || !s) continue;
      try {
        s.ws.send(enc(t, payload));
      } catch {
        // ignore
      }
    }
  }

  sendTo(slot, t, payload) {
    const s = this.slots[slot];
    if (!s) return;
    try {
      s.ws.send(enc(t, payload));
    } catch {
      // ignore
    }
  }

  lobbyStatePayload() {
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      players: this.slots.map((s) => (s ? { name: s.name, ready: s.ready, locked: s.locked } : null)),
      buildDeadline: this.buildDeadline,
      result: this.result,
    };
  }

  async handleJoin(ws, name, isCreate, reconnectToken) {
    // reconnect by token
    if (reconnectToken) {
      const idx = this.slots.findIndex((s) => s && s.token === reconnectToken);
      if (idx >= 0) {
        const s = this.slots[idx];
        s.ws = ws;
        this.state.acceptWebSocket(ws);
        ws.serializeAttachment({ slot: idx });
        this.sendTo(idx, "welcome", { slot: idx, reconnectToken, state: this.lobbyStatePayload() });
        this.broadcast("peer_reconnected", { slot: idx }, idx);
        return true;
      }
    }

    const free = this.slots.findIndex((s) => s === null);
    if (free === -1) {
      // replace a disconnected socket that has exceeded its grace? reject for now
      return false;
    }
    const token = crypto.randomUUID();
    this.slots[free] = { name, ws, token, ready: false, locked: false, bp: null, bpHash: null, lastSeen: Date.now() };
    this.state.acceptWebSocket(ws);
    ws.serializeAttachment({ slot: free });

    this.sendTo(free, "welcome", { slot: free, reconnectToken: token, host: free === 0, state: this.lobbyStatePayload() });
    this.broadcast("lobby_state", this.lobbyStatePayload());
    if (this.slots[1 - free]) this.sendTo(1 - free, "peer_joined", { slot: free, name });
    this.ensureRegistryUpdate();

    if (this.phase === "build") {
      this.sendTo(free, "build_start", { deadline: this.buildDeadline, settings: this.settings });
    } else if (this.phase === "combat" || this.phase === "countdown") {
      // send the ongoing match state to the reconnecting player
      this.sendTo(free, "match_countdown", {
        seed: this.matchSeed,
        authority: this.authority,
        blueprints: this.slots.map((s) => (s && s.bp ? s.bp : null)),
        arena: this.settings.arena,
        combatLimitSec: this.settings.combatLimitSec,
        startAt: Date.now(),
        resume: true,
      });
      // tell the peer to accept inputs again
      this.broadcast("lobby_state", this.lobbyStatePayload());
    }
    return true;
  }

  async webSocketMessage(ws, message) {
    const slot = this.slotOf(ws);
    if (slot === -1) return;
    const s = this.slots[slot];
    s.lastSeen = Date.now();

    let msg;
    try {
      if (typeof message !== "string" || message.length > 256 * 1024) return;
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.v !== PROTOCOL_VERSION || typeof msg.t !== "string") return;
    const p = msg.payload ?? {};

    switch (msg.t) {
      case "ping":
        this.sendTo(slot, "pong", { t: p.t });
        return;

      case "set_settings": {
        if (slot !== 0 || this.phase !== "lobby") {
          this.sendTo(slot, "error", { code: "forbidden", message: "only host may change settings before lock" });
          return;
        }
        this.settings = { ...this.settings, ...sanitizeSettings(p) };
        this.broadcast("lobby_state", this.lobbyStatePayload());
        return;
      }

      case "set_ready": {
        s.ready = !!p.ready;
        this.broadcast("lobby_state", this.lobbyStatePayload());
        this.maybeStartBuild();
        return;
      }

      case "lock_blueprint": {
        if (this.phase !== "build") return;
        const bpJson = JSON.stringify(p.blueprint ?? null);
        if (bpJson.length > MAX_BP_BYTES) {
          this.sendTo(slot, "error", { code: "bp_too_large", message: "blueprint exceeds size limit" });
          return;
        }
        s.bp = p.blueprint ?? null;
        s.bpHash = typeof p.hash === "string" ? p.hash.slice(0, 64) : null;
        s.locked = true;
        this.sendTo(slot, "lock_ack", { hash: s.bpHash });
        this.broadcast("lobby_state", this.lobbyStatePayload());
        this.maybeStartCountdown();
        return;
      }

      case "input_frame": {
        if (this.phase !== "combat") return;
        // validate shape: {tick, throttle, steer, fire, lift}
        if (typeof p.tick !== "number") return;
        const peer = 1 - slot;
        this.sendTo(peer, "input_frame", { slot, ...pickInput(p) });
        return;
      }

      case "snapshot": {
        if (this.phase !== "combat" || slot !== this.authority) return;
        if (!Array.isArray(p.data) || p.data.length > 64 * 1024) return;
        this.sendTo(1 - slot, "snapshot", { tick: p.tick, data: p.data });
        return;
      }

      case "checksum": {
        if (this.phase !== "combat") return;
        this.sendTo(1 - slot, "checksum", { slot, tick: p.tick, hash: p.hash });
        return;
      }

      case "rematch": {
        this.rematchVotes.add(slot);
        if (this.rematchVotes.size >= 1 && this.phase === "result") {
          // reset to build with same settings; default rematch mode = rebuild
          this.startBuildPhase();
        }
        return;
      }

      default:
        // unknown message types are ignored safely
        return;
    }
  }

  pick = (p) => ({
    tick: Math.max(0, Math.min(1e9, Number(p.tick) || 0)),
    throttle: clampAxis(p.throttle),
    steer: clampAxis(p.steer),
    fire: !!p.fire,
    lift: !!p.lift,
  });

  maybeStartBuild() {
    if (this.phase !== "lobby") return;
    if (this.slots[0] && this.slots[1] && this.slots[0].ready && this.slots[1].ready) {
      this.startBuildPhase();
    }
  }

  startBuildPhase() {
    this.phase = "build";
    this.rematchVotes.clear();
    for (const s of this.slots) {
      if (s) {
        s.ready = false;
        s.locked = false;
        s.bp = null;
        s.bpHash = null;
      }
    }
    // absolute deadline: the DO owns the clock
    this.buildDeadline = Date.now() + this.settings.buildTimeSec * 1000;
    this.broadcast("build_start", { deadline: this.buildDeadline, settings: this.settings });
    this.ensureRegistryUpdate();
    this.armDeadlineTimer();
  }

  armDeadlineTimer() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    const remaining = this.buildDeadline - Date.now();
    if (remaining > 0) {
      this.timeoutTimer = setTimeout(() => {
        if (this.phase === "build") {
          // force-lock anyone who hasn't (empty blueprint counts as their build)
          for (const s of this.slots) {
            if (s && !s.locked) {
              s.locked = true;
              s.bp = s.bp ?? null;
            }
          }
          this.maybeStartCountdown(true);
        } else if (this.phase === "combat") {
          this.finishMatch(null, "time-limit");
        }
      }, remaining + 250);
    }
  }

  maybeStartCountdown(force = false) {
    if (this.phase !== "build") return;
    const both = this.slots[0]?.locked && this.slots[1]?.locked;
    if (!both) {
      if (force) return;
      return;
    }
    this.phase = "countdown";
    this.matchSeed = (Date.now() ^ (this.slots[0]?.bpHash?.length ?? 0) * 2654435761) >>> 0;
    // authority = slot 0 (host) by deterministic room policy in v1
    this.authority = 0;
    const payload = {
      seed: this.matchSeed,
      authority: this.authority,
      blueprints: this.slots.map((s) => (s ? s.bp : null)),
      arena: this.settings.arena,
      combatLimitSec: this.settings.combatLimitSec,
      startAt: Date.now() + 3000,
    };
    this.broadcast("match_countdown", payload);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      this.phase = "combat";
      // combat deadline
      this.buildDeadline = Date.now() + this.settings.combatLimitSec * 1000;
      this.armDeadlineTimer();
    }, 3000);
  }

  finishMatch(winner, reason) {
    if (this.phase === "result") return;
    this.phase = "result";
    this.result = { winner, reason, at: Date.now() };
    this.broadcast("result", this.result);
    this.ensureRegistryUpdate();
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
  }

  async webSocketClose(ws) {
    const slot = this.slotOf(ws);
    if (slot === -1) return;
    const s = this.slots[slot];
    s.ws = null;
    this.broadcast("peer_disconnected", { slot, graceSec: this.phase === "combat" ? COMBAT_GRACE_SEC : BUILD_GRACE_SEC });

    const grace = (this.phase === "combat" ? COMBAT_GRACE_SEC : BUILD_GRACE_SEC) * 1000;
    setTimeout(() => {
      const cur = this.slots[slot];
      if (!cur || cur.ws) return; // reconnected
      if (this.phase === "combat") {
        // disconnect loss for the missing peer
        this.finishMatch(1 - slot, `disconnect (slot ${slot})`);
      } else {
        // remove from room
        this.slots[slot] = null;
        this.broadcast("lobby_state", this.lobbyStatePayload());
        this.ensureRegistryUpdate();
        if (this.slots.every((x) => !x)) {
          this.phase = "lobby";
          if (this.env.REGISTRY && this.code) {
            const regId = this.env.REGISTRY.idFromName("global");
            this.env.REGISTRY.get(regId).fetch("https://registry/remove", {
              method: "POST",
              body: JSON.stringify({ code: this.code }),
            }).catch(() => {});
          }
        }
      }
    }, grace);
  }
}

function clampAxis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function pickInput(p) {
  return {
    tick: Math.max(0, Math.min(1e9, Number(p.tick) || 0)),
    throttle: clampAxis(p.throttle),
    steer: clampAxis(p.steer),
    fire: !!p.fire,
    lift: !!p.lift,
  };
}

function sanitizeSettings(s) {
  const out = {};
  if (Number.isFinite(s.buildTimeSec)) out.buildTimeSec = Math.max(60, Math.min(900, Math.round(s.buildTimeSec)));
  if (Number.isFinite(s.budgetSp)) out.budgetSp = Math.max(300, Math.min(2000, Math.round(s.budgetSp)));
  if (Number.isFinite(s.partLimit)) out.partLimit = Math.max(30, Math.min(120, Math.round(s.partLimit)));
  if (typeof s.arena === "string" && ["foundry", "grid", "pitworks"].includes(s.arena)) out.arena = s.arena;
  if (Number.isFinite(s.combatLimitSec)) out.combatLimitSec = Math.max(120, Math.min(600, Math.round(s.combatLimitSec)));
  if (s.rematch === "rebuild" || s.rematch === "same") out.rematch = s.rematch;
  return out;
}
