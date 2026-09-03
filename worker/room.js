// SCRAP AND STEEL — worker/room.js
// Per-room Durable Object with HIBERNATABLE WebSockets. All match state is
// persisted to DO storage and reloaded on wake; slot identity survives
// hibernation via serializeAttachment; timers use storage.setAlarm (setTimeout
// dies with the isolate and would silently kill rooms — the roadmap forbids it).

const PROTOCOL_VERSION = 1;
const BUILD_GRACE_SEC = 30;
const COMBAT_GRACE_SEC = 12;
const MAX_BP_BYTES = 128 * 1024;
const STATE_KEY = "room";

function enc(t, payload) {
  return JSON.stringify({ v: PROTOCOL_VERSION, t, payload });
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

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.restored = false;
  }

  // ---------- state persistence ----------

  defaultState() {
    return {
      code: null,
      phase: "lobby", // lobby | build | countdown | combat | result
      settings: {
        buildTimeSec: 420,
        budgetSp: 1000,
        partLimit: 120,
        arena: "foundry",
        combatLimitSec: 360,
        rematch: "rebuild",
      },
      buildDeadline: 0,
      combatDeadline: 0,
      matchSeed: 0,
      authority: 0,
      result: null,
      rematchVotes: [],
      // slot meta (ws identity lives in attachments; bp stored under slotbp<i>)
      slots: [null, null],
    };
  }

  async restore() {
    if (this.restored) return;
    this.s = (await this.state.storage.get(STATE_KEY)) ?? this.defaultState();
    this.restored = true;
  }

  async save() {
    await this.state.storage.put(STATE_KEY, this.s);
  }

  slotMeta(i) {
    return this.s.slots[i];
  }

  slotOf(ws) {
    try {
      const att = ws.deserializeAttachment();
      if (att && typeof att.slot === "number") return att.slot;
    } catch {
      // no attachment (should not happen for accepted sockets)
    }
    return -1;
  }

  /** Send to every accepted socket; skips the given slot. Works across hibernation. */
  broadcast(t, payload, exceptSlot = -1) {
    const msg = enc(t, payload);
    for (const ws of this.state.getWebSockets()) {
      const slot = this.slotOf(ws);
      if (slot === -1 || slot === exceptSlot) continue;
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }

  sendTo(slot, t, payload) {
    const msg = enc(t, payload);
    for (const ws of this.state.getWebSockets()) {
      if (this.slotOf(ws) === slot) {
        try {
          ws.send(msg);
        } catch {
          // ignore
        }
      }
    }
  }

  lobbyStatePayload() {
    return {
      code: this.s.code,
      phase: this.s.phase,
      settings: this.s.settings,
      players: this.s.slots.map((s) => (s ? { name: s.name, ready: s.ready, locked: s.locked } : null)),
      buildDeadline: this.s.buildDeadline,
      result: this.s.result,
    };
  }

  async ensureRegistryUpdate() {
    if (!this.s.code || !this.env.REGISTRY) return;
    try {
      const regId = this.env.REGISTRY.idFromName("global");
      const stub = this.env.REGISTRY.get(regId);
      const players = this.s.slots.filter(Boolean).length;
      await stub.fetch("https://registry/update", {
        method: "POST",
        body: JSON.stringify({
          code: this.s.code,
          players,
          status: this.s.phase === "lobby" ? "lobby" : "playing",
          budgetSp: this.s.settings.budgetSp,
          buildTimeSec: this.s.settings.buildTimeSec,
          hostName: this.s.slots[0]?.name || "Player",
        }),
      });
    } catch {
      // registry is best-effort
    }
  }

  // ---------- http ----------

  async fetch(request) {
    const url = new URL(request.url);
    await this.restore();
    if (url.pathname === "/room") {
      const code = url.searchParams.get("code") || "UNSET";
      const name = (url.searchParams.get("name") || "Player").slice(0, 24);
      const isCreate = url.searchParams.get("create") === "1";
      const rt = url.searchParams.get("rt");
      if (!this.s.code) {
        this.s.code = code;
        await this.save();
      }
      const pair = new WebSocketPair();
      const joined = await this.handleJoin(pair[1], name, isCreate, rt);
      if (!joined) {
        return new Response(JSON.stringify({ error: "room full", code: "room_full" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  // ---------- joins ----------

  async handleJoin(ws, name, isCreate, reconnectToken) {
    // reconnect by token
    if (reconnectToken) {
      const idx = this.s.slots.findIndex((s) => s && s.token === reconnectToken);
      if (idx >= 0) {
        this.state.acceptWebSocket(ws, ["room"]);
        ws.serializeAttachment({ slot: idx });
        this.s.slots[idx].connected = true;
        this.s.slots[idx].disconnectedAt = 0;
        await this.save();
        this.sendTo(idx, "welcome", { slot: idx, reconnectToken, state: this.lobbyStatePayload() });
        this.broadcast("peer_reconnected", { slot: idx }, idx);
        if (this.s.phase === "combat" || this.s.phase === "countdown") {
          await this.sendMatchState(idx, true);
        } else if (this.s.phase === "build") {
          this.sendTo(idx, "build_start", { deadline: this.s.buildDeadline, settings: this.s.settings });
        }
        return true;
      }
    }

    const free = this.s.slots.findIndex((s) => s === null);
    if (free === -1) return false;
    const token = crypto.randomUUID();
    this.s.slots[free] = { name, token, ready: false, locked: false, connected: true, bpHash: null };
    await this.save();
    this.state.acceptWebSocket(ws, ["room"]);
    ws.serializeAttachment({ slot: free });

    this.sendTo(free, "welcome", { slot: free, reconnectToken: token, host: free === 0, state: this.lobbyStatePayload() });
    this.broadcast("lobby_state", this.lobbyStatePayload());
    if (this.s.slots[1 - free]) this.sendTo(1 - free, "peer_joined", { slot: free, name });
    this.ensureRegistryUpdate();

    if (this.s.phase === "build") {
      this.sendTo(free, "build_start", { deadline: this.s.buildDeadline, settings: this.s.settings });
    } else if (this.s.phase === "combat" || this.s.phase === "countdown") {
      await this.sendMatchState(free, true);
    }
    return true;
  }

  async sendMatchState(slot, resume) {
    // blueprints live in per-slot storage keys so they survive hibernation
    const bp0 = await this.state.storage.get("slotbp0");
    const bp1 = await this.state.storage.get("slotbp1");
    this.sendTo(slot, "match_countdown", {
      seed: this.s.matchSeed,
      authority: this.s.authority,
      blueprints: [bp0 ?? null, bp1 ?? null],
      arena: this.s.settings.arena,
      combatLimitSec: this.s.settings.combatLimitSec,
      startAt: Date.now(),
      resume,
    });
  }

  // ---------- messages ----------

  async webSocketMessage(ws, message) {
    await this.restore();
    const slot = this.slotOf(ws);
    if (slot === -1) return;
    const s = this.s.slots[slot];
    if (!s) return;

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
        if (slot !== 0 || this.s.phase !== "lobby") {
          this.sendTo(slot, "error", { code: "forbidden", message: "only host may change settings before lock" });
          return;
        }
        this.s.settings = { ...this.s.settings, ...sanitizeSettings(p) };
        await this.save();
        this.broadcast("lobby_state", this.lobbyStatePayload());
        return;
      }

      case "set_ready": {
        s.ready = !!p.ready;
        await this.save();
        this.broadcast("lobby_state", this.lobbyStatePayload());
        await this.maybeStartBuild();
        return;
      }

      case "lock_blueprint": {
        if (this.s.phase !== "build") return;
        const bpJson = JSON.stringify(p.blueprint ?? null);
        if (bpJson.length > MAX_BP_BYTES) {
          this.sendTo(slot, "error", { code: "bp_too_large", message: "blueprint exceeds size limit" });
          return;
        }
        await this.state.storage.put(`slotbp${slot}`, p.blueprint ?? null);
        s.bp = p.blueprint ?? null;
        s.bpHash = typeof p.hash === "string" ? p.hash.slice(0, 64) : null;
        s.locked = true;
        await this.save();
        this.sendTo(slot, "lock_ack", { hash: s.bpHash });
        this.broadcast("lobby_state", this.lobbyStatePayload());
        await this.maybeStartCountdown();
        return;
      }

      case "input_frame": {
        if (this.s.phase !== "combat") return;
        if (typeof p.tick !== "number") return;
        this.sendTo(1 - slot, "input_frame", { slot, ...pickInput(p) });
        return;
      }

      case "snapshot": {
        if (this.s.phase !== "combat" || slot !== this.s.authority) return;
        if (!Array.isArray(p.data) || p.data.length > 64 * 1024) return;
        this.sendTo(1 - slot, "snapshot", { tick: p.tick, data: p.data });
        return;
      }

      case "checksum": {
        if (this.s.phase !== "combat") return;
        this.sendTo(1 - slot, "checksum", { slot, tick: p.tick, hash: p.hash });
        return;
      }

      case "rematch": {
        if (this.s.phase !== "result") return;
        if (!this.s.rematchVotes.includes(slot)) this.s.rematchVotes.push(slot);
        await this.save();
        await this.startBuildPhase(); // default rematch mode: rebuild
        return;
      }

      default:
        // unknown message types are ignored safely
        return;
    }
  }

  // ---------- phase machine ----------

  async maybeStartBuild() {
    if (this.s.phase !== "lobby") return;
    if (this.s.slots[0]?.ready && this.s.slots[1]?.ready) await this.startBuildPhase();
  }

  async startBuildPhase() {
    this.s.phase = "build";
    this.s.rematchVotes = [];
    for (const s of this.s.slots) {
      if (s) {
        s.ready = false;
        s.locked = false;
        s.bp = null;
        s.bpHash = null;
      }
    }
    await this.state.storage.delete("slotbp0");
    await this.state.storage.delete("slotbp1");
    // absolute deadline: the DO owns the clock
    this.s.buildDeadline = Date.now() + this.s.settings.buildTimeSec * 1000;
    await this.save();
    this.broadcast("build_start", { deadline: this.s.buildDeadline, settings: this.s.settings });
    this.ensureRegistryUpdate();
    await this.armDeadlineTimer();
  }

  async armDeadlineTimer() {
    // alarms are the only timers that survive hibernation
    let at = 0;
    if (this.s.phase === "build") at = this.s.buildDeadline + 250;
    else if (this.s.phase === "countdown") at = this.s.combatStartAt + 250;
    else if (this.s.phase === "combat") at = this.s.combatDeadline + 250;
    if (at > 0) this.state.storage.setAlarm(at);
  }

  async maybeStartCountdown(force = false) {
    if (this.s.phase !== "build") return;
    const both = this.s.slots[0]?.locked && this.s.slots[1]?.locked;
    if (!both && !force) return;
    this.s.phase = "countdown";
    this.s.matchSeed = (Date.now() ^ (this.s.slots[0]?.bpHash?.length ?? 0) * 2654435761) >>> 0;
    this.s.authority = 0; // deterministic room policy in v1
    this.s.combatStartAt = Date.now() + 3000;
    await this.save();
    const payload = {
      seed: this.s.matchSeed,
      authority: this.s.authority,
      blueprints: [
        await this.state.storage.get("slotbp0"),
        await this.state.storage.get("slotbp1"),
      ],
      arena: this.s.settings.arena,
      combatLimitSec: this.s.settings.combatLimitSec,
      startAt: Date.now() + 3000,
    };
    this.broadcast("match_countdown", payload);
    await this.armDeadlineTimer(); // alarm fires at combat start
  }

  async finishMatch(winner, reason) {
    if (this.s.phase === "result") return;
    this.s.phase = "result";
    this.s.result = { winner, reason, at: Date.now() };
    await this.save();
    this.broadcast("result", this.s.result);
    this.ensureRegistryUpdate();
    await this.state.storage.deleteAlarm();
  }

  async alarm() {
    await this.restore();
    const now = Date.now();
    if (this.s.phase === "build" && now >= this.s.buildDeadline) {
      // force-lock anyone who hasn't (empty blueprint counts as their build)
      for (const s of this.s.slots) {
        if (s && !s.locked) {
          s.locked = true;
          await this.state.storage.put(`slotbp${this.s.slots.indexOf(s)}`, s.bp ?? null);
        }
      }
      await this.save();
      await this.maybeStartCountdown(true);
    } else if (this.s.phase === "countdown" && now >= this.s.combatStartAt) {
      this.s.phase = "combat";
      this.s.combatDeadline = this.s.combatStartAt + this.s.settings.combatLimitSec * 1000;
      await this.save();
      await this.armDeadlineTimer();
    } else if (this.s.phase === "combat" && now >= this.s.combatDeadline) {
      await this.finishMatch(null, "time-limit");
    }
    // disconnect grace checks
    for (let i = 0; i < 2; i++) {
      const s = this.s.slots[i];
      if (s && s.disconnectedAt && !s.connected) {
        const grace = (this.s.phase === "combat" ? COMBAT_GRACE_SEC : BUILD_GRACE_SEC) * 1000;
        if (now - s.disconnectedAt >= grace) {
          if (this.s.phase === "combat") {
            await this.finishMatch(1 - i, `disconnect (slot ${i})`);
          } else {
            this.s.slots[i] = null;
            await this.save();
            this.broadcast("lobby_state", this.lobbyStatePayload());
            this.ensureRegistryUpdate();
            if (this.s.slots.every((x) => !x)) await this.cleanup();
          }
        }
      }
    }
  }

  async cleanup() {
    this.s.phase = "lobby";
    await this.save();
    if (this.env.REGISTRY && this.s.code) {
      const regId = this.env.REGISTRY.idFromName("global");
      this.env.REGISTRY.get(regId)
        .fetch("https://registry/remove", {
          method: "POST",
          body: JSON.stringify({ code: this.s.code }),
        })
        .catch(() => {});
    }
  }

  async webSocketError(ws) {
    // treat as a close for grace purposes
    await this.webSocketClose(ws);
  }

  async webSocketClose(ws) {
    await this.restore();
    const slot = this.slotOf(ws);
    if (slot === -1) return;
    const s = this.s.slots[slot];
    if (!s) return;
    s.connected = false;
    s.disconnectedAt = Date.now();
    await this.save();
    this.broadcast("peer_disconnected", { slot, graceSec: this.s.phase === "combat" ? COMBAT_GRACE_SEC : BUILD_GRACE_SEC });
    // alarm also polls disconnect grace; an explicit short alarm keeps it snappy
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
}
