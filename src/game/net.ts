// SCRAP & STEEL — game/net.ts
// Relay client for online 1v1. Uses the existing Room/Registry DO relay:
//   ?create=1 / ?code=XXXX, lobby settings, absolute build deadline, lock-in,
//   match seed, input frames, authority snapshots, checksums, reconnect grace.
// 2D inputs are packed onto the protocol fields:
//   throttle = forward - back   |  steer = aux  |  fire = fire  |  lift = turret axis
// A ping goes once a second with this client's ping and frame rate, for the
// relay's lag log. The client also sends its ping to every Cloudflare region
// (netprobe.js), and follows `move` when the relay moves the room to a fairer
// region at match start: it reconnects to the room's shard with its ticket.
// A dev's pass (netdev.js) rides on every join of this client, moves included.

import { NetPing } from "./netping.js";
import { probeRegions } from "./netprobe.js";

export const PROTOCOL_VERSION = 1;
export const GAME_VERSION = "1.0.0";

export function resolveRelayUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get("relay");
  if (override) return override;
  const w = window as unknown as { SCRAP_STEEL_RELAY_URL?: string };
  if (w.SCRAP_STEEL_RELAY_URL) return w.SCRAP_STEEL_RELAY_URL;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "ws://localhost:8787";
  return "wss://relay.scrap.andrenijman.com";
}

export type RelayEvent =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "error"; message: string }
  | { kind: "message"; t: string; payload: unknown };

export class RelayClient {
  ws: WebSocket | null = null;
  url: string;
  private seq = 0;
  private listeners: ((e: RelayEvent) => void)[] = [];
  reconnectToken: string | null = null;
  /** This socket's NetPing; `pinger.rtt` is the last round trip in ms (-1 before the first pong). */
  pinger: NetPing | null = null;
  private pingTimer = 0;
  /** The room this client is in, the region it runs in (relay's welcome), and its shard once moved. */
  roomCode: string | null = null;
  region = "";
  shard = "";
  /** Set while reconnecting to a moved room; the region it moved to. */
  movingTo = "";
  private probes: Record<string, number> | null = null;
  private probesSentOn: WebSocket | null = null;
  /** This browser's dev pass (netdev.js devPass()), sent with every join; null for everyone else. */
  dev: string | null = null;

  constructor(url?: string) {
    this.url = url ?? resolveRelayUrl();
  }

  on(fn: (e: RelayEvent) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private emit(e: RelayEvent) {
    for (const fn of [...this.listeners]) fn(e);
  }

  connect(query: string) {
    const saved = sessionStorage.getItem("scrap_reconnect_token");
    const full = `${this.url}/ws?${query}&v=${PROTOCOL_VERSION}&gv=${encodeURIComponent(GAME_VERSION)}${saved ? `&rt=${encodeURIComponent(saved)}` : ""}${this.dev ? `&dev=${encodeURIComponent(this.dev)}` : ""}`;
    this.ws = new WebSocket(full);
    const ws = this.ws;
    probeRegions().then((ms: Record<string, number> | null) => {
      this.probes = ms;
      if (this.ws === ws) this.sendProbes();
    });
    this.stopPing();
    const pinger = new NetPing();
    this.pinger = pinger;
    this.ws.onopen = () => {
      this.pingTimer = window.setInterval(() => this.send("ping", pinger.next()), 1000);
      this.emit({ kind: "open" });
    };
    this.ws.onclose = () => {
      if (this.pinger === pinger) this.stopPing();
      this.emit({ kind: "close" });
    };
    this.ws.onerror = () => this.emit({ kind: "error", message: "WebSocket error" });
    this.ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(String(ev.data));
        // netdev.js's standard announcement comes without the protocol envelope
        if (env?.t === "dev-joined") { this.emit({ kind: "message", t: env.t, payload: { name: String(env.name ?? "") } }); return; }
        if (env.v !== PROTOCOL_VERSION || typeof env.t !== "string") return;
        if (env.t === "pong") this.pinger?.pong((env.payload as { c?: number } | undefined)?.c);
        if (env.t === "welcome") {
          const p = env.payload as { reconnectToken?: string; region?: string; state?: { code?: string } } | undefined;
          if (p?.reconnectToken) {
            this.reconnectToken = p.reconnectToken;
            try { sessionStorage.setItem("scrap_reconnect_token", p.reconnectToken); } catch { /* ignore */ }
          }
          if (p?.state?.code) this.roomCode = p.state.code;
          this.region = typeof p?.region === "string" ? p.region : "";
          this.sendProbes();
        }
        if (env.t === "spectate") {
          // a dev watching a full room: no seat, but the same room and region
          const p = env.payload as { region?: string; state?: { code?: string } } | undefined;
          if (p?.state?.code) this.roomCode = p.state.code;
          this.region = typeof p?.region === "string" ? p.region : "";
        }
        this.emit({ kind: "message", t: env.t, payload: env.payload });
        if (env.t === "move") this.follow(env.payload as { shard?: string; region?: string; ticket?: string });
        else if (env.t === "welcome" || env.t === "spectate") this.movingTo = "";
      } catch {
        // malformed frame ignored
      }
    };
  }

  send(t: string, payload?: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (payload && typeof payload === "object") {
      for (const v of Object.values(payload as Record<string, unknown>)) {
        if (typeof v === "number" && !Number.isFinite(v)) return; // no NaN on the wire
      }
    }
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t, payload, seq: ++this.seq }));
  }

  /** This player's region pings, sent once per socket when both exist. */
  private sendProbes() {
    if (!this.probes || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.probesSentOn === this.ws) return;
    this.probesSentOn = this.ws;
    this.send("regions", { ms: this.probes });
  }

  /** The room moved: reconnect to its shard (with our seat's ticket, if we had one). */
  private follow(m: { shard?: string; region?: string; ticket?: string }) {
    const code = this.roomCode ?? new URLSearchParams(this.ws?.url.split("?")[1] ?? "").get("code");
    if (!m?.shard || !code) return;
    const old = this.ws;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      try { old.close(); } catch { /* ignore */ }
    }
    this.shard = m.shard;
    this.movingTo = m.region ?? "";
    this.connect(`code=${encodeURIComponent(code)}&shard=${encodeURIComponent(m.shard)}${m.ticket ? `&ticket=${encodeURIComponent(m.ticket)}` : ""}`);
  }

  close() {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  private stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    this.pinger?.stop();
    this.pinger = null;
  }
}

export interface NetInputs { forward: number; back: number; fire: number; aux: number; turret: number }

export function packInputs(i: NetInputs): { tick: number; throttle: number; steer: number; fire: number; lift: number } {
  return {
    tick: 0,
    throttle: i.forward - i.back,
    steer: i.aux,
    fire: i.fire,
    lift: i.turret,
  };
}

export function unpackInputs(p: { throttle?: number; steer?: number; fire?: number; lift?: number }): NetInputs {
  const t = p.throttle ?? 0;
  return { forward: Math.max(0, t), back: Math.max(0, -t), fire: p.fire ? 1 : 0, aux: p.steer ?? 0, turret: p.lift ?? 0 };
}
