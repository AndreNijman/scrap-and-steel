// Electrical power network tests
import { describe, it, expect } from "vitest";
import { createNet, solveNet, stepFuses, isFuseTripped } from "../src/game/electric";
import { emptyBlueprint, type Blueprint } from "../src/game/blueprint";

function powerBp(): Blueprint {
  const bp = emptyBlueprint("p");
  bp.parts = [
    { id: "bat", def: "battery_small", x: 0, y: 0, rot: 0 },
    { id: "fuse", def: "fuse", x: 1, y: 0, rot: 0 },
    { id: "mot", def: "motor_industrial", x: 2, y: 0, rot: 0 },
  ];
  bp.wires = [
    { id: "w1", a: { part: "bat", port: 0 }, b: { part: "fuse", port: 0 } },
    { id: "w2", a: { part: "fuse", port: 2 }, b: { part: "mot", port: 0 } },
  ];
  return bp;
}

describe("power network", () => {
  it("powers a wired load from a battery", () => {
    const bp = powerBp();
    const net = createNet(bp);
    const demands = new Map([["mot", 900]]);
    const alive = new Set(["bat", "fuse", "mot"]);
    solveNet(bp, net, demands, alive, dt(), 0);
    expect(net.loads.get("mot")?.powered).toBe(true);
    expect(net.loads.get("mot")?.deliveredWatts).toBe(900);
  });

  it("unwired loads stay unpowered", () => {
    const bp = powerBp();
    bp.wires = [];
    const net = createNet(bp);
    solveNet(bp, net, new Map([["mot", 900]]), new Set(["bat", "fuse", "mot"]), dt(), 0);
    expect(net.loads.get("mot")?.powered ?? false).toBe(false);
  });

  it("demand beyond generation drains the battery and sags voltage", () => {
    const bp = powerBp();
    const net = createNet(bp);
    const alive = new Set(["bat", "fuse", "mot"]);
    // battery_small: 2000 kJ, burst 6000 W; motor_industrial draws 2400 W
    const initial = net.storedKJ;
    solveNet(bp, net, new Map([["mot", 5000]]), alive, 1, 0);
    // 5000 W demand: 0 W generation -> battery covers, sag applies
    expect(net.busVoltage).toBeLessThan(48);
    // simulate one second of drain at 60 Hz
    for (let i = 0; i < 60; i++) solveNet(bp, net, new Map([["mot", 5000]]), alive, 1 / 60, 0);
    expect(net.storedKJ).toBeLessThan(initial);
  });

  it("fuses trip under sustained overload and reset", () => {
    const bp = powerBp();
    const net = createNet(bp);
    const alive = new Set(["bat", "fuse", "mot"]);
    // motor_industrial 2400 W @ 48 V = 50 A > fuse 30 A
    solveNet(bp, net, new Map([["mot", 2400]]), alive, 1, 0);
    for (let i = 0; i < 30; i++) stepFuses(bp, net, 0.1);
    expect(isFuseTripped(net, "fuse")).toBe(true);
    // while tripped, the motor is unpowered
    solveNet(bp, net, new Map([["mot", 2400]]), alive, 1, 0);
    expect(net.loads.get("mot")?.powered ?? true).toBe(false);
    // after cooldown it resets
    for (let i = 0; i < 60; i++) stepFuses(bp, net, 0.1);
    expect(isFuseTripped(net, "fuse")).toBe(false);
  });

  it("severing a wire cuts downstream loads", () => {
    const bp = powerBp();
    const net = createNet(bp);
    net.wires.get("w2")!.broken = true;
    solveNet(bp, net, new Map([["mot", 900]]), new Set(["bat", "fuse", "mot"]), dt(), 0);
    expect(net.loads.get("mot")?.powered ?? true).toBe(false);
  });
});

function dt() { return 1 / 60; }
