// Plain-Node stand-ins for a Room Durable Object's state, sockets and env,
// shared by the latency unit tests.
import { Room } from "../../worker/room.js";

export interface FakeSocket {
  att: unknown;
  sent: string[];
  closed: { code: number; reason: string } | null;
  serializeAttachment(a: unknown): void;
  deserializeAttachment(): unknown;
  send(m: string): void;
  close(code: number, reason: string): void;
}

export function fakeSocket(): FakeSocket {
  return {
    att: null,
    sent: [],
    closed: null,
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
    send(m) { this.sent.push(m); },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

export function fakeState() {
  const store = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  const alarms: number[] = [];
  return {
    store,
    sockets,
    alarms,
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
      delete: async (k: string) => { store.delete(k); },
      setAlarm: async (at: number) => { alarms.push(at); },
      deleteAlarm: async () => {},
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => { sockets.push(ws); },
    waitUntil: () => {},
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const sent = (ws: FakeSocket) => ws.sent.map((m) => JSON.parse(m));

export async function makeRoom(env: Record<string, unknown> = {}) {
  const state = fakeState();
  const logs: { game: string; log: any }[] = [];
  const room = new Room(state, { NETLOG: { record: async (game: string, log: unknown) => { logs.push({ game, log }); return { ok: true }; } }, ...env });
  room.colo = "FRA";
  await room.restore();
  room.s.code = "ABCDE";
  const msg = (ws: FakeSocket, t: string, payload: unknown) => room.webSocketMessage(ws, JSON.stringify({ v: 1, t, payload }));
  return { room, state, logs, msg };
}
