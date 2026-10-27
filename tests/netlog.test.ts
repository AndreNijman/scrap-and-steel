// Relay lag log: one NetLog record per online match
import { describe, it, expect } from "vitest";
import { Room } from "../worker/room.js";

interface FakeSocket {
  att: unknown;
  sent: string[];
  serializeAttachment(a: unknown): void;
  deserializeAttachment(): unknown;
  send(m: string): void;
}

function fakeSocket(): FakeSocket {
  return {
    att: null,
    sent: [],
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
    send(m) { this.sent.push(m); },
  };
}

async function makeRoom() {
  const store = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  const alarms: number[] = [];
  const state = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
      setAlarm: async (at: number) => { alarms.push(at); },
      deleteAlarm: async () => {},
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => { sockets.push(ws); },
    waitUntil: () => {},
  };
  const logs: { game: string; log: any }[] = [];
  const env = { NETLOG: { record: async (game: string, log: unknown) => { logs.push({ game, log }); return { ok: true }; } } };
  const room = new Room(state, env);
  room.colo = "PER";
  await room.restore();
  room.s.code = "ABCD";
  const a = fakeSocket();
  const b = fakeSocket();
  await room.handleJoin(a, "Alice", true, null);
  await room.handleJoin(b, "Bob", false, null);
  const msg = (ws: FakeSocket, t: string, payload: unknown) => room.webSocketMessage(ws, JSON.stringify({ v: 1, t, payload }));
  await msg(a, "set_ready", { ready: true });
  await msg(b, "set_ready", { ready: true });
  return { room, logs, a, b, msg, alarms };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("relay lag log", () => {
  it("a finished match sends one record to games-guard", async () => {
    const { room, logs, a, b, msg } = await makeRoom();
    expect(room.s.phase).toBe("build");
    for (let k = 0; k < 20; k++) {
      await msg(a, "ping", { c: k, rtt: 40 + k, fps: 60, frameMax: 20 });
      await msg(b, "ping", { c: k, rtt: 300 + k, fps: 58, frameMax: 35 });
    }
    expect(JSON.parse(a.sent.at(-1)!)).toMatchObject({ t: "pong", payload: { c: 19 } });
    room.net!.startedAt -= 60_000;
    room.s.phase = "combat";
    room.s.combatDeadline = Date.now() - 1;
    await room.alarm();
    await tick();

    expect(room.s.phase).toBe("result");
    expect(logs.length).toBe(1);
    expect(logs[0]!.game).toBe("scrap");
    const { log } = logs[0]!;
    expect(log.outcome).toBe("finished");
    expect(log.code).toBe("ABCD");
    expect(log.colo).toBe("PER");
    expect(log.mode).toBe("1v1 · foundry");
    expect(log.seats.map((s: { name: string }) => s.name)).toEqual(["Alice", "Bob"]);
    expect(log.seats[0].rttP95).toBeLessThan(100);
    expect(log.seats[1].rttP95).toBeGreaterThanOrEqual(300);
    expect(log.seats[1].fpsMed).toBe(58);
    expect(room.net).toBe(null);

    await msg(a, "rematch", {});
    await tick();
    expect(logs.length).toBe(1);
  });

  it("a disconnect after a KO is finished, one without a result is abandoned and logged once", async () => {
    for (const ko of [true, false]) {
      const { room, logs, a, b, msg } = await makeRoom();
      room.net!.startedAt -= 30_000;
      room.s.phase = "combat";
      room.s.combatDeadline = Date.now() + 60_000;
      await msg(a, "input_frame", { tick: 2, throttle: 1 });
      await msg(a, "input_frame", { tick: 4, throttle: 1 });
      if (ko) await msg(a, "checksum", { tick: 900, hash: "x" });
      await room.webSocketClose(b);
      room.s.slots[1].disconnectedAt -= 13_000;
      await room.alarm();
      await room.alarm();
      await tick();
      expect(logs.length).toBe(1);
      expect(logs[0]!.log.outcome).toBe(ko ? "finished" : "abandoned");
    }
  });

  it("an emptied room logs closed, a match under 10 s not at all", async () => {
    const { room, logs, a, b } = await makeRoom();
    await room.webSocketClose(a);
    await room.webSocketClose(b);
    room.s.slots[0].disconnectedAt -= 31_000;
    room.s.slots[1].disconnectedAt -= 31_000;
    await room.alarm();
    await tick();
    expect(room.s.phase).toBe("lobby");
    expect(logs.length).toBe(0);

    const second = await makeRoom();
    second.room.net!.startedAt -= 30_000;
    await second.room.webSocketClose(second.a);
    await second.room.webSocketClose(second.b);
    second.room.s.slots[0].disconnectedAt -= 31_000;
    second.room.s.slots[1].disconnectedAt -= 31_000;
    await second.room.alarm();
    await tick();
    expect(second.logs.length).toBe(1);
    expect(second.logs[0]!.log.outcome).toBe("closed");
  });
});

describe("disconnect grace", () => {
  it("keeps the alarm going until the grace runs out, then forfeits", async () => {
    const { room, logs, b, alarms } = await makeRoom();
    room.net!.startedAt -= 30_000;
    room.s.phase = "combat";
    room.s.combatDeadline = Date.now() + 60_000;
    await room.webSocketClose(b);
    alarms.length = 0;
    await room.alarm(); // the 1 s poll, grace not up yet
    expect(alarms.length).toBe(1);
    expect(alarms[0]!).toBeLessThan(room.s.combatDeadline);
    room.s.slots[1].disconnectedAt -= 13_000;
    await room.alarm();
    await tick();
    expect(room.s.phase).toBe("result");
    expect(logs.length).toBe(1);
  });

  it("puts the phase deadline back once the player is back", async () => {
    const { room, b, alarms } = await makeRoom();
    await room.webSocketClose(b);
    room.s.slots[1].connected = true;
    room.s.slots[1].disconnectedAt = 0;
    alarms.length = 0;
    await room.alarm();
    expect(alarms).toEqual([room.s.buildDeadline + 250]);
  });
});
