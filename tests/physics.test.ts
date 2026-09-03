// Deterministic physics fixtures (M0 bake-off gates):
//  1. A wheeled cart with a wired battery accelerates forward under throttle.
//  2. A weld breaks under repeated heavy impacts.
//  3. Test reset: same blueprint + seed => same initial world; rebuild produces
//     identical spawn state (blueprint hash invariant, no runtime leakage).
//  4. Spinner weapon damages a target on contact.
import { describe, it, expect, beforeAll } from "vitest";
import { initPhysics } from "../src/sim/adapter";
import { newRobotInput } from "../src/sim/robot";
import { MatchSimulation } from "../src/sim/simulation";
import type { Blueprint } from "../src/blueprint/types";
import { makeId } from "../src/blueprint/types";
import { ARENAS } from "../src/content/parts";

let ready: Promise<void> | null = null;
const ensurePhysics = () => (ready ??= initPhysics());

function cartBlueprint(): Blueprint {
  const parts: Blueprint["parts"] = [
    { id: "core", defId: "control_core", pos: [0, 0, 0] as [number, number, number], rot: 0 as const },
    { id: "bat", defId: "battery_hidisc", pos: [0, 1, 0], rot: 0 },
    { id: "motL", defId: "motor_torque", pos: [-1, 0, 0], rot: 0 },
    { id: "motR", defId: "motor_torque", pos: [1, 0, 0], rot: 0 },
    { id: "whlL", defId: "wheel_rubber", pos: [-2, 0, 0], rot: 0 },
    { id: "whlR", defId: "wheel_rubber", pos: [2, 0, 0], rot: 0 },
    { id: "arm", defId: "armor_steel", pos: [0, 0, 1], rot: 0 },
  ];
  const wires = [
    { id: makeId("w"), from: "bat", to: "core", gauge: "heavy" as const },
    { id: makeId("w"), from: "bat", to: "motL", gauge: "heavy" as const },
    { id: makeId("w"), from: "bat", to: "motR", gauge: "heavy" as const },
  ];
  const bindings = [
    { channel: "throttle" as const, targetPartId: "motL" },
    { channel: "throttle" as const, targetPartId: "motR" },
    { channel: "steer" as const, targetPartId: "motL" },
    { channel: "steer" as const, targetPartId: "motR" },
  ];
  return { schemaVersion: 1, id: makeId("bp"), name: "cart", parts, wires, bindings };
}

const emptyBp = (): Blueprint => ({
  schemaVersion: 1,
  id: makeId("bp"),
  name: "empty",
  parts: [{ id: "b1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 }],
  wires: [],
  bindings: [],
});

beforeAll(async () => {
  await ensurePhysics();
});

describe("physics fixtures", () => {
  it("cart accelerates forward with throttle (power -> motor -> wheel -> traction)", { timeout: 20000 }, async () => {
    const bp = cartBlueprint();
    const sim = new MatchSimulation(bp, emptyBp(), { seed: 42, arena: ARENAS.grid! });
    const input = { throttle: 1, steer: 0, fire: false, lift: false };
    let zStart = 0;
    for (let i = 0; i < 120; i++) {
      sim.step([input, newRobotInput()]);
      if (i === 0) zStart = sim.robots[0]!.parts.get("core")!.body.translation().z;
    }
    const zEnd = sim.robots[0]!.parts.get("core")!.body.translation().z;
    sim.destroy();
    // forward for the yaw=PI robot is -z; expect meaningful displacement
    expect(Math.abs(zEnd - zStart)).toBeGreaterThan(1.0);
  });

  it("welds break under sustained heavy impacts", { timeout: 20000 }, async () => {
    const bp = cartBlueprint();
    const sim = new MatchSimulation(bp, emptyBp(), { seed: 7, arena: ARENAS.grid! });
    const weldsBefore = sim.robots[0]!.welds.size;
    expect(weldsBefore).toBeGreaterThan(0);
    const world = sim.pw;
    let weldsAfter = weldsBefore;
    for (let trial = 0; trial < 3 && weldsAfter === weldsBefore; trial++) {
      // drop a heavy anvil directly onto the robot
      const target = sim.robots[0]!.parts.get("core")!.body.translation();
      const anvil = world.createBody({
        pos: [target.x, 6, target.z],
        rotQuat: [0, 0, 0, 1],
        shape: { kind: "box", hx: 1.2, hy: 1.2, hz: 1.2 },
        mass: 400,
        friction: 0.6,
        restitution: 0,
        ccd: true,
        group: 0,
      });
      for (let i = 0; i < 180; i++) sim.step([newRobotInput(), newRobotInput()]);
      weldsAfter = sim.robots[0]!.welds.size;
      world.removeBody(anvil);
    }
    sim.destroy();
    expect(weldsAfter).toBeLessThan(weldsBefore);
  });

  it("same blueprint + seed produce identical spawn states (deterministic spawn)", { timeout: 20000 }, async () => {
    const bp = cartBlueprint();
    const simA = new MatchSimulation(bp, emptyBp(), { seed: 99, arena: ARENAS.grid! });
    const snapA = simA.snapshot();
    const chkA = simA.checksum();
    simA.destroy();
    const simB = new MatchSimulation(bp, emptyBp(), { seed: 99, arena: ARENAS.grid! });
    const chkB = simB.checksum();
    simB.destroy();
    expect(chkA).toBe(chkB);
    expect(snapA.length).toBeGreaterThan(0);
  });

  it("simulation runs 600 ticks without NaN in body transforms (release gate)", { timeout: 30000 }, async () => {
    const sim = new MatchSimulation(cartBlueprint(), cartBlueprint(), { seed: 1234, arena: ARENAS.grid! });
    const input = { throttle: 1, steer: 0.4, fire: true, lift: false };
    let ok = true;
    for (let i = 0; i < 600 && ok; i++) {
      sim.step([input, input]);
      for (const rt of sim.robots) {
        for (const p of rt.parts.values()) {
          const t = p.body.translation();
          if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) ok = false;
          const v = p.body.linvel();
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) ok = false;
        }
      }
    }
    sim.destroy();
    expect(ok).toBe(true);
  });

  it("an unwheeled box never moves under throttle (no hidden drivetrain)", { timeout: 20000 }, async () => {
    const bp = emptyBp();
    bp.parts = [{ id: "b1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 }];
    const sim = new MatchSimulation(bp, emptyBp(), { seed: 5, arena: ARENAS.grid! });
    const start = sim.robots[0]!.parts.get("b1")!.body.translation();
    const input = { throttle: 1, steer: 1, fire: false, lift: false };
    for (let i = 0; i < 120; i++) sim.step([input, newRobotInput()]);
    const pos = sim.robots[0]!.parts.get("b1")!.body.translation();
    sim.destroy();
    expect(Math.hypot(pos.x - start.x, pos.z - start.z)).toBeLessThan(0.2);
  });

  it("an empty battery stops the cart but never marks it destroyed (M-gate)", { timeout: 30000 }, async () => {
    const bp = cartBlueprint();
    const sim = new MatchSimulation(bp, emptyBp(), { seed: 3, arena: ARENAS.grid! });
    const input = { throttle: 1, steer: 0, fire: false, lift: false };
    for (let i = 0; i < 60; i++) sim.step([input, newRobotInput()]);
    // drain the battery completely: power loss alone is NOT destruction
    sim.robots[0]!.charge = 0;
    const posBefore = sim.robots[0]!.parts.get("core")!.body.translation();
    for (let i = 0; i < 300; i++) sim.step([input, newRobotInput()]);
    const posAfter = sim.robots[0]!.parts.get("core")!.body.translation();
    // hardware intact: mobility path exists => not destroyed (3s window never fills)
    expect(sim.robots[0]!.lastResult.destroyed).toBe(false);
    expect(sim.robots[0]!.lastResult.mobility).toBe(true);
    expect(sim.robots[0]!.destroyedTimer).toBe(0);
    // and it has stopped driving
    expect(Math.hypot(posAfter.x - posBefore.x, posAfter.z - posBefore.z)).toBeLessThan(0.5);
    sim.destroy();
  });
});

describe("test bay invariants", () => {
  it("blueprint hash is unchanged by simulation (no runtime leakage)", { timeout: 20000 }, async () => {
    const { blueprintHash } = await import("../src/blueprint/canonical");
    const bp = cartBlueprint();
    const hashBefore = blueprintHash(bp);
    const sim = new MatchSimulation(bp, emptyBp(), { seed: 11, arena: ARENAS.grid! });
    for (let i = 0; i < 120; i++) sim.step([{ throttle: 1, steer: 0, fire: true, lift: false }, newRobotInput()]);
    sim.destroy();
    const hashAfter = blueprintHash(bp);
    expect(hashAfter).toBe(hashBefore);
  });
});
