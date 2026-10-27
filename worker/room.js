// SCRAP AND STEEL — worker/room.js
// Per-room Durable Object with HIBERNATABLE WebSockets. All match state is
// persisted to DO storage and reloaded on wake; slot identity survives
// hibernation via serializeAttachment; timers use storage.setAlarm (setTimeout
// dies with the isolate and would silently kill rooms — the roadmap forbids it).
//
// When both players are ready, a room whose players are far apart may move to
// a fairer region first (netplace.js): it hands the room to a fresh object
// there, its "shard" `<code>~<shard>`, and sends both players a ticket to
// reconnect with. Later joiners to the old code are sent on to the shard
// until it empties. A moved room never moves again.

import { NetStats, sendNetLog, coloOf } from "./netstats.js";
import { REGIONS, whereOf, chooseRegion, newShard, shardRegion, roomStub, regionOfColo } from "./netplace.js";

const PROTOCOL_VERSION = 1;
const BUILD_GRACE_SEC = 30;
const COMBAT_GRACE_SEC = 12;
const MAX_BP_BYTES = 128 * 1024;
const STATE_KEY = "room";
const ADOPT_WAIT_MS = 6000; // a moved room starts with whoever reconnected by then
const MOVE_CLOSE_MS = 1000; // old sockets close this long after `move`
const PING_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };

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

// A player's netprobe.js results as sent ({ weur: 38, apac: 290 }), kept to known regions.
function cleanProbes(ms) {
  if (!ms || typeof ms !== "object") return null;
  const out = {};
  for (const region of REGIONS) {
    const v = Number(ms[region]);
    if (Number.isFinite(v) && v > 0 && v < 10000) out[region] = Math.round(v);
  }
  return Object.keys(out).length ? out : null;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

function newTicket() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.restored = false;
    this.net = null; // lag stats for the match in progress (in memory only)
    this.netOutcomeSeen = false;
    this.colo = "";
    this.rtts = new Map(); // token -> last five reported pings, for placement (in memory only)
    this.moving = false; // a hand-off to a shard is in flight
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
      // placement: in the old room once it moved, { shard, region }; in a
      // shard, its name, the colo it moved from, and until the match starts
      // the seats waiting for their tickets, { tickets: { ticket: slot }, until }
      moved: null,
      shard: "",
      movedFrom: "",
      adoption: null,
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

  // Where this object runs (DEV_COLO fakes it under wrangler dev).
  async locate() {
    if (!this.colo) this.colo = this.env?.DEV_COLO || (await coloOf());
  }

  region() {
    return shardRegion(this.s.shard) || regionOfColo(this.colo);
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
    // From another room object (never reachable from outside: the Worker only
    // forwards /ping and websocket upgrades to /room).
    if (request.method === "POST" && url.pathname === "/_adopt") return this.adopt(await request.json());
    if (request.method === "POST" && url.pathname === "/_released") {
      await this.released((await request.json()).shard);
      return new Response(null, { status: 204 });
    }
    // The room's ping target: where it runs, timed by the waiting room.
    if (url.pathname === "/ping") {
      await this.locate();
      return new Response(JSON.stringify({ colo: this.colo, region: this.region() }), { headers: PING_HEADERS });
    }
    if (url.pathname === "/room") {
      const code = url.searchParams.get("code") || "UNSET";
      const name = (url.searchParams.get("name") || "Player").slice(0, 24);
      const isCreate = url.searchParams.get("create") === "1";
      const rt = url.searchParams.get("rt");
      const ticket = url.searchParams.get("ticket") || "";
      await this.locate();
      if (this.s.moved) return this.sendOnward();
      if (!this.s.code) {
        this.s.code = code;
        await this.save();
      }
      const pair = new WebSocketPair();
      const joined = await this.handleJoin(pair[1], name, isCreate, rt, whereOf(request), ticket);
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

  // The room moved: tell the player where; they join the shard as usual. The
  // game's client closes this socket itself on `move`; for one that doesn't
  // (an older cached client), its next message (pings go once a second)
  // closes it (under wrangler dev, a close from here or from an alarm never
  // reached the client).
  sendOnward() {
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.state.acceptWebSocket(ws, ["moved"]);
    ws.serializeAttachment({ slot: -1, moved: true }); // not a player here
    ws.send(enc("move", { shard: this.s.moved.shard, region: this.s.moved.region }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- joins ----------

  /**
   * `where` is netplace.js's { country, edge } for the player, when known.
   * `ticket` is a seat in a moved room, given out by the room's old object.
   * @param {{ country: string, edge: string } | null} [where]
   * @param {string} [ticket]
   */
  async handleJoin(ws, name, isCreate, reconnectToken, where = null, ticket = "") {
    // a ticket back into a moved room's seat, else reconnect by token
    const adoption = this.s.adoption;
    let idx = -1;
    if (ticket && adoption && adoption.tickets[ticket] !== undefined) idx = adoption.tickets[ticket];
    else if (reconnectToken) idx = this.s.slots.findIndex((s) => s && s.token === reconnectToken);
    if (idx >= 0 && this.s.slots[idx]) {
      const token = this.s.slots[idx].token;
      this.state.acceptWebSocket(ws, ["room"]);
      ws.serializeAttachment({ slot: idx });
      this.s.slots[idx].connected = true;
      this.s.slots[idx].disconnectedAt = 0;
      if (where) this.s.slots[idx].where = where;
      this.net?.reconnect(token);
      this.net?.seat(token, this.s.slots[idx].name, where);
      if (adoption) for (const [t, i] of Object.entries(adoption.tickets)) if (i === idx) delete adoption.tickets[t];
      await this.save();
      this.sendTo(idx, "welcome", { slot: idx, reconnectToken: token, host: idx === 0, state: this.lobbyStatePayload(), region: this.region() });
      if (adoption) {
        this.broadcast("lobby_state", this.lobbyStatePayload());
        if (!Object.keys(adoption.tickets).length) await this.adopted();
        return true;
      }
      this.broadcast("peer_reconnected", { slot: idx }, idx);
      if (this.s.phase === "combat" || this.s.phase === "countdown") {
        await this.sendMatchState(idx, true);
      } else if (this.s.phase === "build") {
        this.sendTo(idx, "build_start", { deadline: this.s.buildDeadline, settings: this.s.settings });
      }
      return true;
    }

    const free = this.s.slots.findIndex((s) => s === null);
    if (free === -1) return false;
    const token = crypto.randomUUID();
    this.s.slots[free] = { name, token, ready: false, locked: false, connected: true, bpHash: null, where };
    this.net?.seat(token, name, where);
    await this.save();
    this.state.acceptWebSocket(ws, ["room"]);
    ws.serializeAttachment({ slot: free });

    this.sendTo(free, "welcome", { slot: free, reconnectToken: token, host: free === 0, state: this.lobbyStatePayload(), region: this.region() });
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
    if (slot === -1) {
      if (ws.deserializeAttachment()?.moved) try { ws.close(4000, "moved"); } catch { /* gone */ }
      return;
    }
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
      case "ping": {
        // the last five reported pings, for placement at match start
        if (typeof p.rtt === "number" && p.rtt > 0 && p.rtt < 60000) {
          const rtts = this.rtts.get(s.token) ?? [];
          rtts.push(p.rtt);
          if (rtts.length > 5) rtts.shift();
          this.rtts.set(s.token, rtts);
        }
        this.net?.ping(s.token, p.rtt, p.fps, p.frameMax);
        this.sendTo(slot, "pong", { t: p.t, c: typeof p.c === "number" ? p.c : undefined });
        return;
      }

      case "regions": {
        s.probes = cleanProbes(p.ms);
        await this.save();
        return;
      }

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
        this.net?.message(s.token);
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
        this.netOutcomeSeen = true; // clients send it once their sim reaches a result
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
    if (this.s.phase !== "lobby" || this.moving) return;
    if (!(this.s.slots[0]?.ready && this.s.slots[1]?.ready)) return;
    // a new match may first move somewhere fairer; if the move fails it starts here
    const choice = this.mayMove() ? chooseRegion(this.s.slots.map((s) => this.placeOf(s))) : null;
    if (choice && (await this.moveRoom(choice))) return;
    if (this.s.phase === "lobby" && this.s.slots[0]?.ready && this.s.slots[1]?.ready) await this.startBuildPhase();
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
    this.startNetLog();
    this.broadcast("build_start", { deadline: this.s.buildDeadline, settings: this.s.settings });
    this.ensureRegistryUpdate();
    await this.armDeadlineTimer();
  }

  async armDeadlineTimer() {
    // alarms are the only timers that survive hibernation
    let at = 0;
    if (this.s.adoption) at = this.s.adoption.until;
    else if (this.s.phase === "build") at = this.s.buildDeadline + 250;
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
    // the relay never sees a KO; a disconnect after a client's result checksum is a finished match
    this.endNetLog(reason === "time-limit" || this.netOutcomeSeen ? "finished" : "abandoned");
    this.broadcast("result", this.s.result);
    this.ensureRegistryUpdate();
    await this.state.storage.deleteAlarm();
  }

  async alarm() {
    await this.restore();
    const now = Date.now();
    if (this.s.adoption && now >= this.s.adoption.until) await this.adopted();
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
    // a disconnect's 1 s alarm replaced the phase deadline: keep polling while
    // anyone is still inside their grace, then put the deadline back
    if (this.s.slots.some((s) => s && s.disconnectedAt && !s.connected)) {
      await this.state.storage.setAlarm(Date.now() + 1000);
    } else {
      await this.armDeadlineTimer();
    }
  }

  // ---------- lag log ----------

  // One record per match, from the build phase to the result (or until the
  // room empties), sent to games-guard's NetLog.
  startNetLog() {
    this.endNetLog("abandoned");
    this.net = new NetStats();
    this.netOutcomeSeen = false;
    for (const s of this.s.slots) if (s) this.net.seat(s.token, s.name, s.where);
    if (!this.colo) this.locate();
  }

  endNetLog(outcome) {
    const net = this.net;
    this.net = null;
    if (!net) return;
    const record = net.record({
      code: this.s.code, mode: `1v1 · ${this.s.settings.arena}`, outcome, colo: this.colo, region: this.region(),
      moved: this.s.shard ? { from: this.s.movedFrom, to: shardRegion(this.s.shard) } : null,
    });
    if (record.runTime < 10) return;
    sendNetLog(this.env, this.state, "scrap", record);
  }

  async cleanup() {
    this.endNetLog("closed");
    this.s.phase = "lobby";
    await this.save();
    if (this.s.shard) this.release();
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

  // ---------- room placement ----------

  // When both players are ready the room asks netplace.js's chooseRegion
  // whether another region is clearly fairer. If so it hands the room to a
  // shard there (/_adopt), gives each player a ticket for their seat, and
  // remembers the move so later joiners follow. The shard starts the build
  // phase once both tickets are back (or after ADOPT_WAIT_MS), and tells the
  // old object when it empties (/_released).
  mayMove() {
    return !!(this.env?.ROOMS && this.s.code && !this.s.shard && !this.s.moved && this.s.slots.every((s) => s && s.connected));
  }

  placeOf(s) {
    return { probes: s?.probes || null, rtt: median(this.rtts.get(s?.token) || []) };
  }

  async moveRoom(choice) {
    this.moving = true;
    try {
      const code = this.s.code;
      const shard = newShard(choice.region);
      const tickets = {};
      const ticketOf = [];
      this.s.slots.forEach((s, i) => {
        if (!s) return;
        ticketOf[i] = newTicket();
        tickets[ticketOf[i]] = { slot: i };
      });
      const state = {
        settings: this.s.settings,
        slots: this.s.slots.map((s) => s && { name: s.name, token: s.token, where: s.where || null, probes: s.probes || null }),
      };
      try {
        const res = await roomStub(this.env.ROOMS, code, shard).fetch("https://room/_adopt", {
          method: "POST",
          body: JSON.stringify({ code, shard, from: this.colo, state, tickets }),
        });
        if (!res.ok) throw new Error(`adopt answered ${res.status}`);
      } catch (e) {
        console.error("room move failed, starting here", e);
        return false;
      }
      this.s.moved = { shard, region: choice.region };
      this.s.slots = [null, null];
      await this.save();
      const sockets = [];
      for (const ws of this.state.getWebSockets()) {
        const slot = this.slotOf(ws);
        if (slot === -1) continue;
        try { ws.send(enc("move", { shard, region: choice.region, ticket: ticketOf[slot] })); } catch { /* gone */ }
        ws.serializeAttachment({ slot: -1 }); // its close is no longer a disconnect here
        sockets.push(ws);
      }
      // Clients close these themselves on `move`; this is for one that doesn't.
      // A plain timer is enough: nothing is lost if it dies with the isolate.
      setTimeout(() => { for (const ws of sockets) try { ws.close(4000, "moved"); } catch { /* gone */ } }, MOVE_CLOSE_MS);
      return true;
    } finally {
      this.moving = false;
    }
  }

  // In the shard: take over the room, its seats waiting for their tickets.
  async adopt({ code, shard, from, state, tickets }) {
    if (!code || !shardRegion(shard) || !state || !tickets || this.s.adoption || this.s.slots.some(Boolean)) {
      return new Response("cannot adopt", { status: 409 });
    }
    this.s = this.defaultState();
    this.s.code = String(code);
    this.s.shard = shard;
    this.s.movedFrom = String(from || "");
    this.s.settings = { ...this.s.settings, ...sanitizeSettings(state.settings || {}) };
    this.s.slots = [0, 1].map((i) => {
      const p = state.slots?.[i];
      if (!p || typeof p.token !== "string") return null;
      // both readied in the old room; connected once their ticket is back
      return {
        name: String(p.name || "Player").slice(0, 24), token: p.token, ready: true, locked: false,
        connected: false, disconnectedAt: 0, bpHash: null, where: p.where || null, probes: p.probes || null,
      };
    });
    const seats = {};
    for (const [ticket, seat] of Object.entries(tickets)) if (this.s.slots[seat?.slot]) seats[ticket] = seat.slot;
    this.s.adoption = { tickets: seats, until: Date.now() + ADOPT_WAIT_MS };
    await this.save();
    await this.armDeadlineTimer();
    this.ensureRegistryUpdate();
    return new Response(null, { status: 204 });
  }

  // Both tickets are back, or time is up: start with whoever is here. Seats
  // nobody came back to are dropped, as after a disconnect's grace; a player
  // left alone waits for an opponent as in any lobby.
  async adopted() {
    if (!this.s.adoption) return;
    this.s.adoption = null;
    for (let i = 0; i < 2; i++) if (this.s.slots[i] && !this.s.slots[i].connected) this.s.slots[i] = null;
    await this.save();
    if (this.s.slots.every((x) => !x)) {
      await this.cleanup();
      return;
    }
    if (this.s.slots[0] && this.s.slots[1]) {
      await this.startBuildPhase();
      return;
    }
    this.broadcast("lobby_state", this.lobbyStatePayload());
    this.ensureRegistryUpdate();
  }

  // In the shard, once empty: the room's own code is free again.
  release() {
    if (!this.env?.ROOMS || !this.s.code) return;
    const sent = roomStub(this.env.ROOMS, this.s.code)
      .fetch("https://room/_released", { method: "POST", body: JSON.stringify({ shard: this.s.shard }) })
      .catch((e) => console.error("room release failed", e));
    this.state.waitUntil?.(sent);
  }

  async released(shard) {
    if (!this.s.moved || this.s.moved.shard !== shard) return;
    this.s.moved = null;
    await this.save();
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
