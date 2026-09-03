// SCRAP AND STEEL — net/client.ts
// Relay WebSocket client. Endpoint resolution order (TUNG convention):
//   1. ?relay= URL parameter
//   2. window.SCRAP_STEEL_RELAY_URL
//   3. production relay (wss://relay.scrap.andrenijman.com)
//   4. localhost fallback in development

import { encode, parseEnvelope, PROTOCOL_VERSION, GAME_VERSION, type MsgType } from "../../shared/protocol";

export function resolveRelayUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get("relay");
  if (override) return override;
  const w = window as unknown as { SCRAP_STEEL_RELAY_URL?: string };
  if (w.SCRAP_STEEL_RELAY_URL) return w.SCRAP_STEEL_RELAY_URL;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "ws://localhost:8787";
  }
  return "wss://relay.scrap.andrenijman.com";
}

export type RelayEvent =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "error"; message: string }
  | { kind: "message"; t: MsgType; payload: unknown };

export class RelayClient {
  ws: WebSocket | null = null;
  private seq = 0;
  private listeners: ((e: RelayEvent) => void)[] = [];
  url: string;
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
    for (const fn of this.listeners) fn(e);
  }

  connect(query: string) {
    const full = `${this.url}/ws?${query}&v=${PROTOCOL_VERSION}&gv=${encodeURIComponent(GAME_VERSION)}`;
    const saved = sessionStorage.getItem("scrap_reconnect_token");
    this.ws = new WebSocket(full + (saved ? `&rt=${encodeURIComponent(saved)}` : ""));
    this.ws.onopen = () => this.emit({ kind: "open" });
    this.ws.onclose = () => this.emit({ kind: "close" });
    this.ws.onerror = () => this.emit({ kind: "error", message: "WebSocket error" });
    this.ws.onmessage = (ev) => {
      const env = parseEnvelope(String(ev.data));
      if (!env) return;
      if (env.t === "welcome") {
        const p = env.payload as { reconnectToken?: string } | undefined;
        if (p?.reconnectToken) {
          this.reconnectToken = p.reconnectToken;
          try {
            sessionStorage.setItem("scrap_reconnect_token", p.reconnectToken);
          } catch {
            // non-fatal
          }
        }
      }
      this.emit({ kind: "message", t: env.t, payload: env.payload });
    };
  }

  send(t: MsgType, payload?: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // release gate: no NaN/Infinity on the wire
    if (payload !== undefined && payload !== null && typeof payload === "object") {
      for (const key of Object.keys(payload as object)) {
        const v = (payload as Record<string, unknown>)[key];
        if (typeof v === "number" && !Number.isFinite(v)) return;
      }
    }
    this.ws.send(encode(t, payload, ++this.seq));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  ping() {
    this.send("ping", { t: Date.now() });
  }
}
