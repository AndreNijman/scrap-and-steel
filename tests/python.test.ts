import { describe, it, expect, beforeAll } from "vitest";
import { compilePython } from "../src/game/python";
import { initPhysics } from "../src/game/physics";
import { Simulation } from "../src/game/sim";
import { ARENAS } from "../src/game/arena";
import { emptyBlueprint } from "../src/game/blueprint";

beforeAll(async () => {
  await initPhysics();
});

describe("compilePython", () => {
  it("python drive program populates motor outputs", () => {
    const src = `drive = clamp(forward() - back(), -1, 1)\nmotor("m1", drive)\nmotor("m2", drive)`;
    const res = compilePython(src);
    expect(res.ok).toBe(true);
    const motorPowers = new Map<string, number>();
    const api = {
      forward: () => 1, back: () => 0, fire: () => 0, aux: () => 0, turret: () => 0,
      sensor: () => 0,
      motor: (id: string, v: number) => motorPowers.set(id, v),
      servo: () => {}, weapon: () => {}, brake: () => {},
      clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
      abs: Math.abs, min: Math.min, max: Math.max,
      pid: () => 0, remember: () => {}, recall: () => 0,
    };
    res.fn!(api);
    expect(motorPowers.get("m1")).toBe(1);
    expect(motorPowers.get("m2")).toBe(1);
  });

  it("supports conditionals, ternary and boolean operators", () => {
    const src = `
x = 10
y = 20
active = 1 if (x < y and not False) else 0
if active == 1:
    motor("m1", 0.75)
else:
    motor("m1", 0)
`;
    const res = compilePython(src);
    expect(res.ok).toBe(true);
    let power = 0;
    const api = {
      forward: () => 0, back: () => 0, fire: () => 0, aux: () => 0, turret: () => 0,
      sensor: () => 0,
      motor: (_id: string, v: number) => { power = v; },
      servo: () => {}, weapon: () => {}, brake: () => {},
      clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
      abs: Math.abs, min: Math.min, max: Math.max,
      pid: () => 0, remember: () => {}, recall: () => 0,
    };
    res.fn!(api);
    expect(power).toBe(0.75);
  });
});

describe("Simulation with Python", () => {
  it("resolves part id suffixes and executes in sim tick", () => {
    const bp = emptyBlueprint("py_cart");
    bp.parts = [
      { id: "frame1", def: "steel_block", x: 1, y: 0, rot: 0 },
      { id: "frame2", def: "steel_block", x: 2, y: 0, rot: 0 },
      { id: "bat1", def: "battery_small", x: 1, y: -1, rot: 0 },
      { id: "cpu1", def: "micro_controller", x: 2, y: -1, rot: 0 },
      { id: "motor_left_99", def: "motor_small", x: 1, y: 1, rot: 0 },
      { id: "motor_right_99", def: "motor_small", x: 2, y: 1, rot: 0 },
      { id: "w1", def: "wheel_medium", x: 1, y: 2, rot: 0 },
      { id: "w2", def: "wheel_medium", x: 2, y: 2, rot: 0 },
    ];
    bp.wires = [
      { id: "w_pwr1", a: { part: "bat1", port: 0 }, b: { part: "cpu1", port: 0 } },
      { id: "w_pwr2", a: { part: "bat1", port: 0 }, b: { part: "motor_left_99", port: 0 } },
      { id: "w_pwr3", a: { part: "motor_left_99", port: 2 }, b: { part: "motor_right_99", port: 0 } },
      { id: "w_sh1", a: { part: "motor_left_99", port: 2 }, b: { part: "w1", port: 0 }, kind: "shaft" },
      { id: "w_sh2", a: { part: "motor_right_99", port: 2 }, b: { part: "w2", port: 0 }, kind: "shaft" },
    ];
    bp.logicMode = "python";
    // Using 4-char suffix "_99" instead of full "motor_left_99"
    bp.python = `
drive = forward() - back()
motor("_99", drive)
`;
    const sim = new Simulation({ bpA: bp, bpB: null, arena: ARENAS.range!, seed: 1 });
    sim.robots[0]!.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    sim.step(1 / 60);

    // Motor powers should have been set on the resolved part id
    const leftCmd = sim.lastMotorPowers.get("motor_left_99");
    expect(leftCmd).toBe(1);
  });
});
