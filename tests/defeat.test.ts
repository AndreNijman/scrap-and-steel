// Defeat evaluator tests: battery depletion is NOT destruction (release gate).
import { describe, it, expect } from "vitest";
import { evaluateDefeat } from "../src/sim/defeat";
import { buildAiBot } from "../src/combat/ai";
import { RobotRuntime } from "../src/sim/robot";
import { emptyBlueprint, type Blueprint } from "../src/blueprint/types";
import { PART_DEFS } from "../src/content/parts";

/** Register every battery part on the runtime so wire paths can find them. */
function registerBatteries(rt: RobotRuntime, bp: Blueprint) {
  for (const p of bp.parts) {
    const def = PART_DEFS[p.defId];
    if (def?.source) {
      rt.batteries.set(p.id, { energyKJ: def.source.energy, peakW: def.source.peakW, heatCoef: def.source.heatCoef ?? 1, def });
    }
  }
}


function rtOf(bp: Blueprint, side: 0 | 1 = 0): RobotRuntime {
  // build a runtime without physics: only what evaluateDefeat reads
  const rt = new RobotRuntime(bp, side);
  return rt;
}

describe("defeat evaluator", () => {
  it("a wired, wheeled, armed robot with a core is operational", () => {
    const bp = buildAiBot();
    const rt = rtOf(bp);
    // populate parts map minimally: all parts alive
    for (const p of bp.parts) {
      // @ts-expect-error test-only partial runtime
      rt.parts.set(p.id, { partId: p.id, defId: p.defId, destroyed: false, def: { id: p.defId, name: p.defId, category: "frame", desc: "", cost: 0, mass: 1, size: [1, 1, 1], hp: 1, shape: "box" }, hp: 1, maxHp: 1, temp: 25, welds: [], spinOmega: 0 });
    }
    registerBatteries(rt, bp);
    rt.cores = bp.parts.filter((p) => p.defId === "control_core").map((p) => p.id);
    // wheels array: from bp we can derive motor+wheel adjacency manually
    const motors = bp.parts.filter((p) => p.defId === "motor_torque");
    const wheels = bp.parts.filter((p) => p.defId === "wheel_rubber");
    rt.wheels = wheels.map((w, i) => ({
      wheelPartId: w.id,
      motorPartId: motors[i % motors.length]!.id,
      body: null as never,
      joint: null as never,
      axle: [1, 0, 0],
      sideSign: 1,
    }));
    const res = evaluateDefeat(rt, () => new Set(bp.parts.map((p) => p.id)));
    expect(res.mobility).toBe(true);
    expect(res.offense).toBe(true);
    expect(res.control).toBe(true);
    expect(res.destroyed).toBe(false);
  });

  it("an empty battery does not mark hardware destroyed (charge is not in the graph)", () => {
    const bp = buildAiBot();
    const rt = rtOf(bp);
    for (const p of bp.parts) {
      // @ts-expect-error test-only partial runtime
      rt.parts.set(p.id, { partId: p.id, destroyed: false, def: { id: p.defId, name: p.defId, category: "frame", desc: "", cost: 0, mass: 1, size: [1, 1, 1], hp: 1, shape: "box" }, hp: 1, maxHp: 1, temp: 25, welds: [], spinOmega: 0 });
    }
    registerBatteries(rt, bp);
    rt.cores = bp.parts.filter((p) => p.defId === "control_core").map((p) => p.id);
    const motors = bp.parts.filter((p) => p.defId === "motor_torque");
    const wheels = bp.parts.filter((p) => p.defId === "wheel_rubber");
    rt.wheels = wheels.map((w, i) => ({
      wheelPartId: w.id,
      motorPartId: motors[i % motors.length]!.id,
      body: null as never,
      joint: null as never,
      axle: [1, 0, 0],
      sideSign: 1,
    }));
    rt.charge = 0; // completely depleted
    const res = evaluateDefeat(rt, () => new Set(bp.parts.map((p) => p.id)));
    expect(res.destroyed).toBe(false); // hardware intact => not destroyed
  });

  it("no mobility + no offense => destroyed (rammer with dead weapons stays alive via mobility)", () => {
    const bp = emptyBlueprint("ram");
    bp.parts = [
      { id: "c", defId: "control_core", pos: [0, 0, 0], rot: 0 },
      { id: "bat", defId: "battery_compact", pos: [0, 1, 0], rot: 0 },
      { id: "m", defId: "motor_compact", pos: [1, 0, 0], rot: 0 },
      { id: "w", defId: "wheel_rubber", pos: [2, 0, 0], rot: 0 },
    ];
    bp.wires = [
      { id: "w1", from: "m", to: "w", gauge: "light" },
      { id: "w2", from: "m", to: "bat", gauge: "medium" },
    ];
    const rt = rtOf(bp);
    for (const p of bp.parts) {
      // @ts-expect-error test-only partial runtime
      rt.parts.set(p.id, { partId: p.id, destroyed: false, def: { id: p.defId, name: p.defId, category: "drive", desc: "", cost: 0, mass: 1, size: [1, 1, 1], hp: 1, shape: "box" }, hp: 1, maxHp: 1, temp: 25, welds: [], spinOmega: 0 });
    }
    rt.cores = ["c"];
    registerBatteries(rt, bp);
    rt.wheels = [
      { wheelPartId: "w", motorPartId: "m", body: null as never, joint: null as never, axle: [1, 0, 0], sideSign: 1 },
    ];
    // rammer: no weapon parts; mobility counts as offense
    const res = evaluateDefeat(rt, () => new Set(["c", "m", "w"]));
    expect(res.mobility).toBe(true);
    expect(res.offense).toBe(true); // rammer rule
    expect(res.destroyed).toBe(false);

    // now kill the wheel => no mobility, no weapon => destroyed
    // @ts-expect-error test-only
    rt.parts.set("w", { partId: "w", destroyed: true, def: { id: "wheel_rubber", name: "w", category: "drive", desc: "", cost: 0, mass: 1, size: [1, 1, 1], hp: 1, shape: "box" }, hp: 0, maxHp: 1, temp: 25, welds: [], spinOmega: 0 });
    const res2 = evaluateDefeat(rt, () => new Set(["c", "m", "bat"]));
    expect(res2.mobility).toBe(false);
    expect(res2.destroyed).toBe(true);
  });
});
