// SCRAP AND STEEL — shared/protocol.ts
// Wire format v1. Every message: { v, t, seq?, payload }. Parsed through these
// validators before anything reaches simulation code. Unknown types are ignored;
// malformed payloads are rejected. The Worker mirrors these checks in JS.

export const PROTOCOL_VERSION = 1;
export const GAME_VERSION = "0.1.0";

export type MsgType =
  // client -> relay
  | "hello"
  | "create_room"
  | "join_room"
  | "set_settings"
  | "set_ready"
  | "lock_blueprint"
  | "input_frame"
  | "snapshot"
  | "checksum"
  | "rematch"
  | "ping"
  // relay -> client
  | "welcome"
  | "lobby_state"
  | "peer_joined"
  | "peer_left"
  | "build_start"
  | "lock_ack"
  | "match_countdown"
  | "result"
  | "peer_disconnected"
  | "peer_reconnected"
  | "error"
  | "pong";

export interface Envelope {
  v: number;
  t: MsgType;
  seq?: number;
  payload?: unknown;
}

export interface LobbySummary {
  code: string;
  players: number;
  status: string;
  hostName: string;
  budgetSp: number;
  buildTimeSec: number;
  createdAt: number;
}

export interface MatchCountdownPayload {
  seed: number;
  authority: 0 | 1;
  blueprints: [unknown, unknown]; // blueprint JSON per slot
  arena: string;
  combatLimitSec: number;
  startAt: number;
}

const MAX_MSG_BYTES = 256 * 1024;

export function parseEnvelope(raw: string): Envelope | null {
  if (raw.length > MAX_MSG_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION) return null;
  if (typeof m.t !== "string") return null;
  return { v: m.v, t: m.t as MsgType, seq: typeof m.seq === "number" ? m.seq : undefined, payload: m.payload };
}

export function encode(t: MsgType, payload?: unknown, seq?: number): string {
  const env: Envelope = { v: PROTOCOL_VERSION, t, payload };
  if (seq !== undefined) env.seq = seq;
  return JSON.stringify(env);
}

/** Reject NaN/Infinity in payloads (release gate: no NaN on the wire). */
export function sanitizePayload(p: unknown): boolean {
  if (typeof p === "number") return Number.isFinite(p);
  if (typeof p !== "object" || p === null) return true;
  if (Array.isArray(p)) return p.every(sanitizePayload);
  return Object.values(p as Record<string, unknown>).every(sanitizePayload);
}
