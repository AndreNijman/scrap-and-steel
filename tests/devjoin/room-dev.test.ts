// Dev join in the Room DO, in plain Node (tests/latency/fake-room.ts): a dev
// (a verified pass's { name }, as room.js's /room hands it to handleJoin) is
// seated when a seat is free and spectates a full room, getting the match
// start, the inputs so far and the live inputs of both players; it takes the
// next seat that frees up between matches. Real pass checking is in
// relay.test.mjs against wrangler dev.
import { describe, it, expect } from "vitest";
import { makeRoom, fakeSocket, sentOf, tick, type FakeSocket } from "../latency/fake-room";

const DEV = { name: "ANDRE" };
const raw = (ws: FakeSocket) => ws.sent.map((m) => JSON.parse(m));
const devJoined = (ws: FakeSocket) => raw(ws).filter((m) => m.t === "dev-joined");

async function fullRoom() {
  const r = await makeRoom();
  const a = fakeSocket();
  const b = fakeSocket();
  await r.room.handleJoin(a, "Alice", true, null);
  await r.room.handleJoin(b, "Bob", false, null);
  return { ...r, a, b };
}

// Both ready, both lock, the countdown alarm: combat.
async function toCombat(r: Awaited<ReturnType<typeof fullRoom>>) {
  await r.msg(r.a, "set_ready", { ready: true });
  await r.msg(r.b, "set_ready", { ready: true });
  await r.msg(r.a, "lock_blueprint", { blueprint: { parts: ["a"] }, hash: "ha" });
  await r.msg(r.b, "lock_blueprint", { blueprint: { parts: ["b"] }, hash: "hb" });
  expect(r.room.s.phase).toBe("countdown");
  r.room.s.combatStartAt = Date.now() - 1;
  await r.room.alarm();
  expect(r.room.s.phase).toBe("combat");
}

const frame = (tick: number, throttle: number, fire = false) => ({ tick, throttle, steer: 0, fire, lift: false });

describe("dev join: seats", () => {
  it("a dev with a free seat is an ordinary player, named by the pass, and everyone hears it", async () => {
    const { room, msg } = await makeRoom();
    const a = fakeSocket();
    const dev = fakeSocket();
    await room.handleJoin(a, "Alice", true, null);
    expect(await room.handleJoin(dev, "Player", false, null, null, "", DEV)).toBe(true);
    expect(room.s.slots[1].name).toBe("ANDRE");
    expect(sentOf(dev, "welcome")[0].payload.slot).toBe(1);
    for (const ws of [a, dev]) expect(devJoined(ws)).toEqual([{ t: "dev-joined", name: "ANDRE" }]);
    // and counts as a normal player: both ready starts the match
    await msg(a, "set_ready", { ready: true });
    await msg(dev, "set_ready", { ready: true });
    expect(room.s.phase).toBe("build");
  });

  it("a dev creating a room is its host", async () => {
    const { room } = await makeRoom();
    const dev = fakeSocket();
    await room.handleJoin(dev, "Player", true, null, null, "", DEV);
    expect(sentOf(dev, "welcome")[0].payload).toMatchObject({ slot: 0, host: true });
    expect(devJoined(dev)).toEqual([{ t: "dev-joined", name: "ANDRE" }]);
  });

  it("a full room still refuses everyone else, and old joins (no dev) are unchanged", async () => {
    const { room, a, b } = await fullRoom();
    expect(await room.handleJoin(fakeSocket(), "Eve", false, null)).toBe(false);
    expect(await room.handleJoin(fakeSocket(), "Eve", false, null, null, "", null)).toBe(false);
    for (const ws of [a, b]) expect(devJoined(ws)).toEqual([]);
  });
});

describe("dev join: spectating a full room", () => {
  it("in the lobby: spectate, the roster unchanged, everyone hears it; the spectator can't play", async () => {
    const { room, a, b, msg } = await fullRoom();
    const dev = fakeSocket();
    expect(await room.handleJoin(dev, "Player", false, null, null, "", DEV)).toBe(true);
    const sp = sentOf(dev, "spectate")[0].payload;
    expect(sp.state.players.map((p: { name: string }) => p.name)).toEqual(["Alice", "Bob"]);
    expect(room.s.slots.map((s: { name: string }) => s.name)).toEqual(["Alice", "Bob"]);
    for (const ws of [a, b, dev]) expect(devJoined(ws)).toEqual([{ t: "dev-joined", name: "ANDRE" }]);
    // pings answered, nothing else does anything
    await msg(dev, "ping", { t: 5, c: 1 });
    expect(sentOf(dev, "pong")[0].payload).toEqual({ t: 5, c: 1 });
    await msg(dev, "set_settings", { budgetSp: 300 });
    await msg(dev, "set_ready", { ready: true });
    expect(room.s.settings.budgetSp).toBe(1000);
    expect(room.s.slots.every((s: { ready: boolean }) => !s.ready)).toBe(true);
    // broadcasts reach the spectator
    await msg(a, "set_ready", { ready: true });
    await msg(b, "set_ready", { ready: true });
    expect(sentOf(dev, "build_start").length).toBe(1);
  });

  it("joining mid-match: the match start, the input changes so far and both players' live inputs", async () => {
    const r = await fullRoom();
    await toCombat(r);
    const { room, a, b, msg } = r;
    for (let t = 0; t <= 20; t += 2) {
      await msg(a, "input_frame", frame(t, t >= 10 ? 1 : 0));
      await msg(b, "input_frame", frame(t + 1, -1, t >= 6));
    }
    const dev = fakeSocket();
    await room.handleJoin(dev, "Player", false, null, null, "", DEV);
    const mc = sentOf(dev, "match_countdown")[0].payload;
    expect(mc).toMatchObject({ seed: room.s.matchSeed, spectate: true, resume: true, startAt: room.s.combatStartAt });
    expect(mc.blueprints).toEqual([{ parts: ["a"] }, { parts: ["b"] }]);
    const log = sentOf(dev, "spectate_log");
    expect(log.length).toBe(1);
    // only changes, in arrival order: a at 0 (idle), b at 1 (back), b at 7 (back + fire), a at 10 (forward)
    expect(log[0].payload).toMatchObject({ done: true, complete: true, ticks: [20, 21] });
    expect(log[0].payload.entries).toEqual([[0, 0, 0, 0, 0, 0], [1, 1, -1, 0, 0, 0], [1, 7, -1, 0, 1, 0], [0, 10, 1, 0, 0, 0]]);
    // live: both players' frames, each with its slot
    await msg(a, "input_frame", frame(22, 0));
    await msg(b, "input_frame", frame(23, 1));
    expect(sentOf(dev, "input_frame").map((m) => [m.payload.slot, m.payload.tick])).toEqual([[0, 22], [1, 23]]);
    // a spectator's own input_frame goes nowhere
    const before = sentOf(a, "input_frame").length + sentOf(b, "input_frame").length;
    await msg(dev, "input_frame", frame(24, 1));
    expect(sentOf(a, "input_frame").length + sentOf(b, "input_frame").length).toBe(before);
    for (const ws of [a, b, dev]) expect(devJoined(ws).length).toBe(1);
  });

  it("a long log comes in chunks; a log lost to a restart says so", async () => {
    const r = await fullRoom();
    await toCombat(r);
    for (let t = 0; t < 5000; t += 2) await r.msg(r.a, "input_frame", frame(t, (t / 2) % 2));
    const dev = fakeSocket();
    await r.room.handleJoin(dev, "Player", false, null, null, "", DEV);
    const chunks = sentOf(dev, "spectate_log").map((m) => m.payload);
    expect(chunks.map((c) => c.entries.length)).toEqual([2000, 500]);
    expect(chunks.map((c) => c.done)).toEqual([false, true]);
    r.room.inputLog = null; // as after the object restarted mid-match
    const dev2 = fakeSocket();
    await r.room.handleJoin(dev2, "Player", false, null, null, "", DEV);
    expect(sentOf(dev2, "spectate_log")[0].payload).toMatchObject({ done: true, complete: false, entries: [] });
  });

  it("takes the seat a player leaves, between matches, and is a full player after", async () => {
    const { room, a, b, msg } = await fullRoom();
    const dev = fakeSocket();
    await room.handleJoin(dev, "Player", false, null, null, "", DEV);
    await room.webSocketClose(b);
    room.s.slots[1].disconnectedAt = Date.now() - 31_000;
    await room.alarm();
    expect(room.s.slots[1].name).toBe("ANDRE");
    expect(sentOf(dev, "welcome")[0].payload).toMatchObject({ slot: 1, host: false });
    expect(sentOf(a, "lobby_state").pop()!.payload.players.map((p: { name: string } | null) => p?.name)).toEqual(["Alice", "ANDRE"]);
    await msg(a, "set_ready", { ready: true });
    await msg(dev, "set_ready", { ready: true });
    expect(room.s.phase).toBe("build");
  });

  it("never mid-match: a forfeit leaves the dev watching until the result, then seats them", async () => {
    const r = await fullRoom();
    await toCombat(r);
    const { room, a, b } = r;
    const dev = fakeSocket();
    await room.handleJoin(dev, "Player", false, null, null, "", DEV);
    await room.webSocketClose(b);
    room.s.slots[1].disconnectedAt = Date.now() - 13_000;
    await room.alarm();
    expect(room.s.phase).toBe("result");
    expect(sentOf(dev, "result").length).toBe(1);
    expect(room.s.slots[1].name).toBe("Bob");
    expect(sentOf(dev, "welcome").length).toBe(0);
    room.s.slots[1].disconnectedAt = Date.now() - 31_000;
    await room.alarm();
    expect(room.s.slots[1].name).toBe("ANDRE");
    expect(sentOf(dev, "welcome")[0].payload.slot).toBe(1);
    // the next match starts with the dev in it
    await r.msg(a, "rematch", {});
    expect(room.s.phase).toBe("build");
    expect(sentOf(dev, "build_start").length).toBe(1);
  });

  it("there is no kick: a host's kick message does nothing to the dev", async () => {
    const { room, msg } = await makeRoom();
    const a = fakeSocket();
    await room.handleJoin(a, "Alice", true, null);
    const dev = fakeSocket();
    await room.handleJoin(dev, "Player", false, null, null, "", DEV);
    await msg(a, "kick", { slot: 1 });
    expect(room.s.slots[1]?.name).toBe("ANDRE");
    expect(dev.closed).toBeNull();
  });

  it("a dev seat is an ordinary seat in the lag log", async () => {
    const { room, logs, msg } = await makeRoom();
    const a = fakeSocket();
    const dev = fakeSocket();
    await room.handleJoin(a, "Alice", true, null, { country: "AU", edge: "PER" });
    await room.handleJoin(dev, "Player", false, null, { country: "DE", edge: "FRA" }, "", DEV);
    await msg(a, "set_ready", { ready: true });
    await msg(dev, "set_ready", { ready: true });
    room.net!.startedAt -= 30_000;
    await room.finishMatch(null, "time-limit");
    await tick();
    expect(logs[0]!.log.seats.map((s: { name: string; country: string }) => [s.name, s.country])).toEqual([["Alice", "AU"], ["ANDRE", "DE"]]);
  });
});
