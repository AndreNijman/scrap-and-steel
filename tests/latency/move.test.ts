// Room placement in plain Node: the move at match start, the shard's
// adoption of the seats, its alarm, and the lag record's region and moved.
import { describe, it, expect } from "vitest";
import { fakeSocket, fakeWorld, makeRoom, sentOf, tick, type FakeSocket } from "./fake-room";

const EUROPE = { weur: 20, eeur: 45, me: 140, apac: 290, oc: 330 };
const ASIA = { weur: 290, eeur: 250, me: 150, apac: 30, oc: 120 };

/** Two players in the room, each with probes and five pings, both ready. */
async function lobby(world = fakeWorld(), players = [{ probes: EUROPE, rtt: 30 }, { probes: ASIA, rtt: 300 }] as { probes: unknown; rtt: number }[]) {
  const r = await makeRoom(world);
  const sockets = [fakeSocket(), fakeSocket()];
  await r.room.handleJoin(sockets[0], "Alice", true, null, { country: "DE", edge: "FRA" });
  await r.room.handleJoin(sockets[1], "Bob", false, null, { country: "SG", edge: "SIN" });
  for (const [i, p] of players.entries()) {
    if (p.probes) await r.msg(sockets[i]!, "regions", { ms: p.probes });
    for (let k = 0; k < 5; k++) await r.msg(sockets[i]!, "ping", { c: k, rtt: p.rtt });
  }
  await r.msg(sockets[0]!, "set_ready", { ready: true });
  await r.msg(sockets[1]!, "set_ready", { ready: true });
  return { ...r, sockets };
}

function shardOf(world: ReturnType<typeof fakeWorld>, shard: string) {
  return world.objects.get(`ABCDE~${shard}`)!;
}

/** Reconnect each socket's player to the shard with its ticket. */
async function rejoin(world: ReturnType<typeof fakeWorld>, moves: { shard: string; ticket: string }[], which = [0, 1]) {
  const shard = shardOf(world, moves[0]!.shard);
  const sockets: FakeSocket[] = [];
  for (const i of which) {
    const ws = fakeSocket();
    await shard.room.handleJoin(ws, "?", false, "rt-from-session", { country: i ? "SG" : "DE", edge: "TST" }, moves[i]!.ticket);
    sockets[i] = ws;
  }
  return { shard, sockets };
}

describe("room placement", () => {
  it("a mixed pair moves to the fairest region and starts on the shard", async () => {
    const { room, sockets, world } = await lobby();
    expect(room.s.phase).toBe("lobby");
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]?.payload);
    expect(moves.every((m) => m && m.shard === moves[0].shard && /^[a-z0-9]{16}$/.test(m.ticket))).toBe(true);
    expect(moves[0].ticket).not.toBe(moves[1].ticket);
    expect(moves[0].region).toBe("me");
    expect(moves[0].shard).toMatch(/^me-[a-z0-9]{6}$/);
    expect(sockets.some((ws) => sentOf(ws, "build_start").length)).toBe(false);
    expect(room.s.moved).toEqual({ shard: moves[0].shard, region: "me" });
    expect(room.s.slots).toEqual([null, null]);
    // the old sockets no longer count as players here
    await room.webSocketClose(sockets[0]!);
    expect(sentOf(sockets[1]!, "peer_disconnected").length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(sockets.every((ws) => ws.closed?.code === 4000 && ws.closed.reason === "moved")).toBe(true);

    const shard = shardOf(world, moves[0].shard);
    expect(Object.keys(shard.room.s.adoption.tickets).length).toBe(2);
    expect(shard.state.alarms.at(-1)).toBe(shard.room.s.adoption.until);
    const back = await rejoin(world, moves, [1]);
    expect(sentOf(back.sockets[1]!, "welcome")[0].payload).toMatchObject({ slot: 1, region: "me", host: false });
    expect(shard.room.s.phase).toBe("lobby");
    const both = await rejoin(world, moves, [0]);
    expect(shard.room.s.phase).toBe("build");
    expect(sentOf(both.sockets[0]!, "build_start").length).toBe(1);
    expect(sentOf(back.sockets[1]!, "build_start").length).toBe(1);
    expect(shard.room.s.slots.map((s: { name: string }) => s.name)).toEqual(["Alice", "Bob"]);
    // a reconnect token from the old room still works in the shard
    const token = sentOf(sockets[0]!, "welcome")[0].payload.reconnectToken;
    expect(shard.room.s.slots[0].token).toBe(token);
    await shard.room.webSocketClose(both.sockets[0]!);
    const again = fakeSocket();
    await shard.room.handleJoin(again, "Alice", false, token, null);
    expect(sentOf(again, "welcome")[0].payload.slot).toBe(0);
  });

  it("the lag record of a moved match has its region and where it moved from", async () => {
    const { sockets, world } = await lobby();
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]!.payload);
    const { shard } = await rejoin(world, moves);
    shard.room.net!.startedAt -= 30_000;
    await shard.room.finishMatch(null, "time-limit");
    await tick();
    expect(world.logs.length).toBe(1);
    const { log } = world.logs[0]!;
    expect(log).toMatchObject({ code: "ABCDE", region: "me", moved: { from: "FRA", to: "me" }, outcome: "finished" });
    expect(log.seats.map((s: { country: string }) => s.country)).toEqual(["DE", "SG"]);
  });

  it("a same-region pair stays and its record says so", async () => {
    const { room, sockets, logs } = await lobby(fakeWorld(), [{ probes: EUROPE, rtt: 25 }, { probes: EUROPE, rtt: 40 }]);
    expect(room.s.phase).toBe("build");
    expect(sockets.some((ws) => sentOf(ws, "move").length)).toBe(false);
    room.net!.startedAt -= 30_000;
    await room.finishMatch(null, "time-limit");
    await tick();
    expect(logs[0]!.log).toMatchObject({ region: "weur", moved: null });
  });

  it("never moves when a player sent no probes (an older client)", async () => {
    const { room, sockets } = await lobby(fakeWorld(), [{ probes: EUROPE, rtt: 30 }, { probes: null, rtt: 300 }]);
    expect(room.s.phase).toBe("build");
    expect(sockets.some((ws) => sentOf(ws, "move").length)).toBe(false);
  });

  it("starts here as before when the shard can't adopt the room", async () => {
    const { room, sockets } = await lobby(fakeWorld({ adoptFails: true }));
    expect(room.s.phase).toBe("build");
    expect(room.s.moved).toBe(null);
    expect(sockets.some((ws) => sentOf(ws, "move").length)).toBe(false);
    expect(sockets.every((ws) => sentOf(ws, "build_start").length === 1)).toBe(true);
  });

  it("a rematch in a moved room never moves again", async () => {
    const { sockets, world } = await lobby();
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]!.payload);
    const { shard, sockets: back } = await rejoin(world, moves);
    expect(shard.room.mayMove()).toBe(false);
    await shard.room.finishMatch(0, "test");
    await shard.room.webSocketMessage(back[0]!, JSON.stringify({ v: 1, t: "rematch", payload: {} }));
    expect(shard.room.s.phase).toBe("build");
    expect(back.some((ws) => sentOf(ws, "move").length)).toBe(false);
  });
});

describe("the shard's adoption wait", () => {
  it("after 6 s it drops the seats nobody came back to; one player waits in the lobby", async () => {
    const { sockets, world } = await lobby();
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]!.payload);
    const { shard, sockets: back } = await rejoin(world, moves, [0]);
    shard.room.s.adoption.until = Date.now() - 1;
    await shard.room.alarm();
    expect(shard.room.s.adoption).toBe(null);
    expect(shard.room.s.phase).toBe("lobby");
    expect(shard.room.s.slots[1]).toBe(null);
    expect(sentOf(back[0]!, "lobby_state").at(-1).payload.players[1]).toBe(null);
    // a late joiner takes the free seat as usual and the match starts on the shard
    const late = fakeSocket();
    await shard.room.handleJoin(late, "Carol", false, null, null);
    await shard.room.webSocketMessage(late, JSON.stringify({ v: 1, t: "set_ready", payload: { ready: true } }));
    expect(shard.room.s.phase).toBe("build");
  });

  it("a disconnect's 1 s alarm does not lose the adoption deadline", async () => {
    const { sockets, world } = await lobby();
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]!.payload);
    const { shard, sockets: back } = await rejoin(world, moves, [0]);
    const until = shard.room.s.adoption.until;
    await shard.room.webSocketClose(back[0]!);
    expect(shard.state.alarms.at(-1)).toBeLessThan(until); // the 1 s poll replaced it
    await shard.room.handleJoin(fakeSocket(), "Alice", false, shard.room.s.slots[0].token, null);
    await shard.room.alarm(); // the poll fires; nobody is inside a grace any more
    expect(shard.room.s.adoption?.until).toBe(until);
    expect(shard.state.alarms.at(-1)).toBe(until);
  });

  it("an empty shard frees the old code", async () => {
    const { room, sockets, world } = await lobby();
    const moves = sockets.map((ws) => sentOf(ws, "move")[0]!.payload);
    const shard = shardOf(world, moves[0].shard);
    shard.room.s.adoption.until = Date.now() - 1;
    await shard.room.alarm(); // nobody came back
    await tick();
    expect(shard.room.s.slots).toEqual([null, null]);
    expect(room.s.moved).toBe(null);
  });
});
