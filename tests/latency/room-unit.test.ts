// Room DO latency features in plain Node: where each player connects from in
// the lag record.
import { describe, it, expect } from "vitest";
import { makeRoom, fakeSocket, tick } from "./fake-room";

describe("lag record: where each player connects from", () => {
  it("records each seat's country and edge, kept across a reconnect", async () => {
    const { room, logs, msg } = await makeRoom();
    const a = fakeSocket();
    const b = fakeSocket();
    await room.handleJoin(a, "Alice", true, null, { country: "AU", edge: "PER" });
    await room.handleJoin(b, "Bob", false, null, { country: "DE", edge: "FRA" });
    await msg(a, "set_ready", { ready: true });
    await msg(b, "set_ready", { ready: true });
    expect(room.s.phase).toBe("build");
    const token = room.s.slots[1].token;
    await room.webSocketClose(b);
    await room.handleJoin(fakeSocket(), "Bob", false, token, { country: "DE", edge: "AMS" });
    room.net!.startedAt -= 30_000;
    room.s.phase = "combat";
    room.s.combatDeadline = Date.now() - 1;
    await room.alarm();
    await tick();
    expect(logs.length).toBe(1);
    const { log } = logs[0]!;
    expect(log.seats.map((s: { country: string; edge: string }) => [s.country, s.edge])).toEqual([["AU", "PER"], ["DE", "AMS"]]);
    expect(log.seats[1].reconnects).toBe(1);
  });

  it("a join without a where (older relay) records empty fields", async () => {
    const { room, logs, msg } = await makeRoom();
    const a = fakeSocket();
    const b = fakeSocket();
    await room.handleJoin(a, "Alice", true, null);
    await room.handleJoin(b, "Bob", false, null);
    await msg(a, "set_ready", { ready: true });
    await msg(b, "set_ready", { ready: true });
    room.net!.startedAt -= 30_000;
    await room.finishMatch(null, "time-limit");
    await tick();
    expect(logs[0]!.log.seats.map((s: { country: string }) => s.country)).toEqual(["", ""]);
  });
});
