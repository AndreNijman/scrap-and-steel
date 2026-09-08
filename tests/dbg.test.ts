import { it } from "vitest";
import { Simulation } from "../src/game/sim";
import { ARENAS } from "../src/game/arena";
import type { Blueprint } from "../src/game/blueprint";
import { emptyBlueprint } from "../src/game/blueprint";

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
    { id: "wa", a: { part: "bat", port: 0 }, b: { part: "cpu", port: 0 }, kind: "power" },
    { id: "wb", a: { part: "bat", port: 0 }, b: { part: "m1", port: 0 }, kind: "power" },
    { id: "wc", a: { part: "m1", port: 1 }, b: { part: "m2", port: 0 }, kind: "power" },
    { id: "ws1", a: { part: "m1", port: 2 }, b: { part: "w1", port: 0 }, kind: "shaft" },
    { id: "ws2", a: { part: "m2", port: 2 }, b: { part: "w2", port: 0 }, kind: "shaft" },
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

it("traction trace", () => {
  const sim = new Simulation({ bpA: cartBp(), bpB: null, arena: ARENAS.range!, seed: 7 });
  const rt = sim.robots[0]!;
  rt.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
  for (let i = 0; i < 180; i++) {
    rt.input = { forward: 1, back: 0, fire: 0, aux: 0, turret: 0 };
    sim.step(1 / 60);
    if (i % 30 === 0) {
      const root = rt.phys.rootBody!.getPosition();
      const vx = rt.phys.rootBody!.getLinearVelocity().x;
      const wheels = rt.phys.wheels.map((w) => {
        const b = rt.phys.bodies.get(w.partId)!.body;
        return `${Number(b.getAngularVelocity()).toFixed(1)}`;
      });
      console.log(`t=${(i/60).toFixed(1)} x=${root.x.toFixed(2)} vx=${vx.toFixed(2)} wheelAv=[${wheels}]`);
    }
  }
});
