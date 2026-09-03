// Power solver tests: paths, derating, wire trips.
import { describe, it, expect } from "vitest";
import { solvePower, analyzePowerGraph } from "../src/sim/power";
import { emptyBlueprint, type Blueprint } from "../src/blueprint/types";

function bpFrom(parts: { id: string; defId: string }[], wires: { id: string; from: string; to: string; gauge: "light" | "medium" | "heavy" }[]): Blueprint {
  const bp = emptyBlueprint("t");
  bp.parts = parts.map((p) => ({ ...p, pos: [0, 0, 0] as [number, number, number], rot: 0 as const }));
  bp.wires = wires;
  return bp;
}

describe("power solver", () => {
  it("powers a motor with a wired battery path", () => {
    const bp = bpFrom(
      [
        { id: "bat", defId: "battery_compact" },
        { id: "mot", defId: "motor_compact" },
      ],
      [{ id: "w1", from: "bat", to: "mot", gauge: "medium" }],
    );
    const net = solvePower(bp, new Set(["bat", "mot"]), new Set(["w1"]), [{ partId: "mot", watts: 1500 }], undefined, 0.25);
    expect(net.loads.get("mot")?.powered).toBe(true);
    expect(net.loads.get("mot")?.regulated).toBe(false);
    expect(net.loads.get("mot")?.deliveredW).toBeCloseTo(1500 * 0.6, 0); // unregulated derate
  });

  it("gives full power when a controller is on the path", () => {
    const bp = bpFrom(
      [
        { id: "bat", defId: "battery_compact" },
        { id: "ctl", defId: "motor_controller" },
        { id: "mot", defId: "motor_compact" },
      ],
      [
        { id: "w1", from: "bat", to: "ctl", gauge: "medium" },
        { id: "w2", from: "ctl", to: "mot", gauge: "medium" },
      ],
    );
    const net = solvePower(bp, new Set(["bat", "ctl", "mot"]), new Set(["w1", "w2"]), [{ partId: "mot", watts: 1500 }], undefined, 0.25);
    expect(net.loads.get("mot")?.powered).toBe(true);
    expect(net.loads.get("mot")?.regulated).toBe(true);
    expect(net.loads.get("mot")?.deliveredW).toBeCloseTo(1500, 0);
  });

  it("leaves loads unpowered without a battery", () => {
    const bp = bpFrom([{ id: "mot", defId: "motor_compact" }], []);
    const net = solvePower(bp, new Set(["mot"]), new Set(), [{ partId: "mot", watts: 1500 }], undefined, 0.25);
    expect(net.loads.get("mot")?.powered).toBe(false);
    expect(net.loads.get("mot")?.deliveredW).toBe(0);
  });

  it("leaves loads unpowered when a wire is severed", () => {
    const bp = bpFrom(
      [
        { id: "bat", defId: "battery_compact" },
        { id: "mot", defId: "motor_compact" },
      ],
      [{ id: "w1", from: "bat", to: "mot", gauge: "medium" }],
    );
    const net = solvePower(bp, new Set(["bat", "mot"]), new Set(), [{ partId: "mot", watts: 1500 }], undefined, 0.25);
    expect(net.loads.get("mot")?.powered).toBe(false);
  });

  it("derates loads when demand exceeds source peak", () => {
    const bp = bpFrom(
      [{ id: "bat", defId: "battery_compact" }, { id: "m1", defId: "motor_compact" }, { id: "m2", defId: "motor_compact" }],
      [
        { id: "w1", from: "bat", to: "m1", gauge: "heavy" },
        { id: "w2", from: "bat", to: "m2", gauge: "heavy" },
      ],
    );
    // battery_compact peak 3200W; controllers absent => 0.6 derate then global scale
    const net = solvePower(
      bp,
      new Set(["bat", "m1", "m2"]),
      new Set(["w1", "w2"]),
      [
        { partId: "m1", watts: 1600 },
        { partId: "m2", watts: 1600 },
      ],
      undefined,
      0.25,
    );
    const total = (net.loads.get("m1")?.deliveredW ?? 0) + (net.loads.get("m2")?.deliveredW ?? 0);
    expect(total).toBeLessThanOrEqual(3200 * 0.6 + 1);
  });

  it("trips an overloaded light wire over time", () => {
    const bp = bpFrom(
      [
        { id: "bat", defId: "battery_hidisc" },
        { id: "wep", defId: "spinner_drum" },
      ],
      [{ id: "w1", from: "bat", to: "wep", gauge: "light" }],
    );
    let net = solvePower(bp, new Set(["bat", "wep"]), new Set(["w1"]), [{ partId: "wep", watts: 4200 }], undefined, 0.1);
    // light wire = 2600W cap; delivered ~2520 (0.6 derate) may not exceed... use heavy load:
    net = solvePower(bp, new Set(["bat", "wep"]), new Set(["w1"]), [{ partId: "wep", watts: 9000 }], net, 0.1);
    let tripped = false;
    for (let i = 0; i < 60 && !tripped; i++) {
      net = solvePower(bp, new Set(["bat", "wep"]), new Set(["w1"]), [{ partId: "wep", watts: 9000 }], net, 0.1);
      if (net.wires.get("w1")?.tripped) tripped = true;
    }
    expect(tripped).toBe(true);
    // while tripped, the load is unpowered
    const after = solvePower(bp, new Set(["bat", "wep"]), new Set(["w1"]), [{ partId: "wep", watts: 9000 }], net, 0.1);
    expect(after.loads.get("wep")?.powered).toBe(false);
  });

  it("preflight flags motors with no wire path", () => {
    const bp = bpFrom(
      [
        { id: "bat", defId: "battery_compact" },
        { id: "mot", defId: "motor_compact" },
      ],
      [],
    );
    const { issues, poweredMotors } = analyzePowerGraph(bp);
    expect(poweredMotors.size).toBe(0);
    expect(issues.some((i) => i.severity === "critical")).toBe(true);
  });
});
