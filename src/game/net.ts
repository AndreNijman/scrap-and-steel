// SCRAP & STEEL — game/net.ts
// Relay client for online 1v1. Uses the existing Room/Registry DO relay:
//   ?create=1 / ?code=XXXX, lobby settings, absolute build deadline, lock-in,
//   match seed, input frames, authority snapshots, checksums, reconnect grace.
// 2D inputs are packed onto the protocol fields:
//   throttle = forward - back   |  steer = aux  |  fire = fire  |  lift = turret axis

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
    const full = `${this.url}/ws?${query}&v=${PROTOCOL_VERSION}&gv=${encodeURIComponent(GAME_VERSION)}${saved ? `&rt=${encodeURIComponent(saved)}` : ""}`;
    this.ws = new WebSocket(full);
    this.ws.onopen = () => this.emit({ kind: "open" });
    this.ws.onclose = () => this.emit({ kind: "close" });
    this.ws.onerror = () => this.emit({ kind: "error", message: "WebSocket error" });
    this.ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(String(ev.data));
        if (env.v !== PROTOCOL_VERSION || typeof env.t !== "string") return;
        if (env.t === "welcome") {
          const p = env.payload as { reconnectToken?: string } | undefined;
          if (p?.reconnectToken) {
            this.reconnectToken = p.reconnectToken;
            try { sessionStorage.setItem("scrap_reconnect_token", p.reconnectToken); } catch { /* ignore */ }
          }
        }
        this.emit({ kind: "message", t: env.t, payload: env.payload });
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

  close() {
    this.ws?.close();
    this.ws = null;
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
