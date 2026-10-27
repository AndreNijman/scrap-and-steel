// Plain-Node stand-ins for Room Durable Objects: state, sockets, alarms, a
// NETLOG that keeps what it is sent, and a ROOMS namespace whose objects are
// Room instances in this process. Shared by the latency unit tests.
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
  const tags = new Map<FakeSocket, string[]>();
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
    getWebSockets: (tag?: string) => sockets.filter((ws) => !tag || tags.get(ws)?.includes(tag)),
    acceptWebSocket: (ws: FakeSocket, wsTags: string[] = []) => { sockets.push(ws); tags.set(ws, wsTags); },
    waitUntil: () => {},
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const sent = (ws: FakeSocket) => ws.sent.map((m) => JSON.parse(m));
export const sentOf = (ws: FakeSocket, t: string) => sent(ws).filter((m) => m.t === t);

export interface World {
  env: Record<string, unknown>;
  logs: { game: string; log: any }[];
  objects: Map<string, { room: Room; state: ReturnType<typeof fakeState> }>;
  object(name: string): { room: Room; state: ReturnType<typeof fakeState> };
}

/** A NETLOG and, unless `rooms` is false, a ROOMS namespace (`adopt` can make /_adopt fail). */
export function fakeWorld({ rooms = true, adoptFails = false } = {}): World {
  const logs: World["logs"] = [];
  const objects: World["objects"] = new Map();
  const env: Record<string, unknown> = { NETLOG: { record: async (game: string, log: unknown) => { logs.push({ game, log }); return { ok: true }; } } };
  const object = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      const state = fakeState();
      const room = new Room(state, env);
      room.colo = "FRA";
      o = { room, state };
      objects.set(name, o);
    }
    return o;
  };
  if (rooms) {
    env.ROOMS = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (adoptFails && new URL(url).pathname === "/_adopt") throw new Error("network");
          return object(name).room.fetch(new Request(url, init));
        },
      }),
    };
  }
  return { env, logs, objects, object };
}

/** The room object for code ABCDE in `world`, with a message helper. */
export async function makeRoom(world: World = fakeWorld({ rooms: false })) {
  const { room, state } = world.object("ABCDE");
  await room.restore();
  room.s.code = "ABCDE";
  const msg = (ws: FakeSocket, t: string, payload: unknown) => room.webSocketMessage(ws, JSON.stringify({ v: 1, t, payload }));
  return { room, state, logs: world.logs, msg, world };
}
