// Physics fixtures: grid-built robots under planck — drive, no-hidden-drivetrain, damage
import { describe, it, expect, beforeAll } from "vitest";
import { initPhysics } from "../src/game/physics";
import { Simulation } from "../src/game/sim";
import { ARENAS } from "../src/game/arena";
import type { Blueprint } from "../src/game/blueprint";
import { emptyBlueprint } from "../src/game/blueprint";

let ready: Promise<void> | null = null;
const ensure = () => (ready ??= initPhysics());

function cartBp(): Blueprint {
  const bp = emptyBlueprint("cart");
  bp.parts = [
    { id: "frame", def: "steel_block", x: 1, y: 0, rot: 0 },
    { id: "frame2", def: "steel_block", x: 2, y: 0, rot: 0 },
    { id: "bat", def: "battery_small", x: 1, y: -1, rot: 0 },
    { id: "cpu", def: "micro_controller", x: 2, y: -1, rot: 0 },
    { id: "m1", def: "motor_small", x: 1, y: 1, rot: 0 },
    { id: "m2", def: "motor_small", x: 2, y: 1, rot: 0 },
    { id: "w1", def: "wheel_medium", x: 1, y: 2, rot: 0 },
    { id: "w2", def: "wheel_medium", x: 2, y: 2, rot: 0 },
  ];
  bp.wires = [
    { id: "wa", a: { part: "bat", port: 0 }, b: { part: "cpu", port: 0 } },
    { id: "wb", a: { part: "bat", port: 0 }, b: { part: "m1", port: 0 } },
    { id: "wc", a: { part: "m1", port: 2 }, b: { part: "m2", port: 0 } },
  ];
  bp.logic = [
    { id: "kf", type: "key_forward", x: 0, y: 0, params: {}, in: {} },
    { id: "kb", type: "key_back", x: 0, y: 1, params: {}, in: {} },
    { id: "mix", type: "sub", x: 0, y: 2, params: {}, in: { a: "kf", b: "kb" } },
    { id: "cl", type: "clamp", x: 0, y: 3, params: { min: -1, max: 1 }, in: { a: "mix" } },
    { id: "o1", type: "motor_power", x: 0, y: 4, params: { part: "m1" }, in: { val: "cl" } },
    { id: "o2", type: "motor_power", x: 0, y: 5, params: { part: "m2" }, in: { val: "cl" } },
  ];
  return bp;
}

beforeAll(async () => { await ensure(); });

describe("2D physics fixtures", () => {
  it("wired cart with drive logic accelerates forward", { timeout: 30000 }, () => {
    const sim = new Simulation({ bpA: cartBp(), bpB: null, arena: ARENAS.range!, seed: 7 });
    sim.robots[0]!.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    const x0 = sim.robots[0]!.phys.rootBody!.getPosition().x;
    for (let i = 0; i < 180; i++) sim.step(1 / 60);
    const x1 = sim.robots[0]!.phys.rootBody!.getPosition().x;
    
    expect(x1 - x0).toBeGreaterThan(1.5);
  });

  it("an unwired motor never moves the robot (no hidden connections)", { timeout: 30000 }, () => {
    const bp = cartBp();
    bp.wires = []; // no power at all
    const sim = new Simulation({ bpA: bp, bpB: null, arena: ARENAS.range!, seed: 7 });
    sim.robots[0]!.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    const x0 = sim.robots[0]!.phys.rootBody!.getPosition().x;
    for (let i = 0; i < 180; i++) sim.step(1 / 60);
    const x1 = sim.robots[0]!.phys.rootBody!.getPosition().x;
    
    expect(Math.abs(x1 - x0)).toBeLessThan(0.3);
  });

  it("spawn settling never destroys parts (grace period)", { timeout: 30000 }, () => {
    const sim = new Simulation({ bpA: cartBp(), bpB: null, arena: ARENAS.range!, seed: 3 });
    sim.robots[0]!.input = { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 };
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    const lost = sim.robots[0]!.partsLost;
    
    expect(lost).toBe(0);
  });

  it("battery depletion stops the cart but never disables it (hardware intact)", { timeout: 60000 }, () => {
    const sim = new Simulation({ bpA: cartBp(), bpB: null, arena: ARENAS.range!, seed: 5 });
    const rt = sim.robots[0]!;
    rt.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    // drain every battery to zero
    for (const src of rt.net.sources.values()) src.energyKJ = 0;
    for (let i = 0; i < 300; i++) sim.step(1 / 60);
    
    expect(rt.defeated).toBe(false); // empty battery is NOT destruction
    expect(rt.lastResult.mobility).toBe(true); // hardware path intact
  });

  it("motors bolted to the chassis drive wheels under the frame (no adjacency trap)", { timeout: 30000 }, () => {
    const bp = cartBp();
    // move the motors UP one row so they are NOT adjacent to the wheels
    for (const p of bp.parts) {
      if (p.id === "m1" || p.id === "m2") p.y = -1;
    }
    bp.parts.push({ id: "frame3", def: "steel_block", x: 1, y: 1, rot: 0 });
    bp.parts.push({ id: "frame4", def: "steel_block", x: 2, y: 1, rot: 0 });
    const sim = new Simulation({ bpA: bp, bpB: null, arena: ARENAS.range!, seed: 9 });
    const rt = sim.robots[0]!;
    rt.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(rt.defeated).toBe(false); // no instant defeat
    expect(rt.lastResult.mobility).toBe(true);
    const x0 = rt.phys.rootBody!.getPosition().x;
    for (let i = 0; i < 180; i++) sim.step(1 / 60);
    const x1 = rt.phys.rootBody!.getPosition().x;
    expect(x1 - x0).toBeGreaterThan(1.5);
  });

  it("runs 600 ticks without NaN in any body transform", { timeout: 60000 }, () => {
    const sim = new Simulation({ bpA: cartBp(), bpB: cartBp(), arena: ARENAS.range!, seed: 11 });
    sim.robots[0]!.input = { forward: 1, back: 0, fire: 1, aux: 0, turret: 0 };
    sim.robots[1]!.input = { forward: -0, back: 0, fire: 0, aux: 0, turret: 0 };
    let ok = true;
    for (let i = 0; i < 600 && ok; i++) {
      sim.step(1 / 60);
      for (const side of sim.robots) {
        if (!side) continue;
        for (const [, pb] of side.phys.bodies) {
          const p = pb.body.getPosition();
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) ok = false;
          const v = pb.body.getLinearVelocity();
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) ok = false;
        }
      }
    }
    
    expect(ok).toBe(true);
  });
});
