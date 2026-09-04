// Logic node graph evaluator tests
import { describe, it, expect } from "vitest";
import { evalLogic, createLogicRuntime, type LogicContext } from "../src/game/logic";

type Node = { id: string; type: string; params: Record<string, string | number>; in: Record<string, string | null> };

function makeCtx(keys = { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 }): LogicContext {
  return {
    keys,
    readSensor: (partId) => ({ "sen1": 42, "bat1": 15 } as Record<string, number>)[partId] ?? 0,
    motorPowers: new Map(),
    servoTargets: new Map(),
    weaponFire: new Map(),
    brake: 0,
  };
}

describe("logic evaluator", () => {
  it("tank drive mix: forward - back clamped -> motor power", () => {
    const rt = createLogicRuntime();
    const ctx = makeCtx({ forward: 1, back: 0, fire: 0, aux: 0, turret: 0 });
    const nodes: Node[] = [
      { id: "kf", type: "key_forward", params: {}, in: {} },
      { id: "kb", type: "key_back", params: {}, in: {} },
      { id: "sub", type: "sub", params: {}, in: { a: "kf", b: "kb" } },
      { id: "cl", type: "clamp", params: { min: -1, max: 1 }, in: { a: "sub" } },
      { id: "out", type: "motor_power", params: { part: "m1" }, in: { val: "cl" } },
    ];
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(ctx.motorPowers.get("m1")).toBe(1);
    ctx.keys = { forward: 0, back: 1, fire: 0, aux: 0, turret: 0 };
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(ctx.motorPowers.get("m1")).toBe(-1);
  });

  it("comparator drives weapon trigger", () => {
    const rt = createLogicRuntime();
    const ctx = makeCtx();
    const nodes: Node[] = [
      { id: "sen", type: "sensor_value", params: { part: "bat1" }, in: {} },
      { id: "c20", type: "constant", params: { value: 20 }, in: {} },
      { id: "lt", type: "lt", params: {}, in: { a: "sen", b: "c20" } },
      { id: "fire", type: "weapon_fire", params: { part: "gun" }, in: { val: "lt" } },
    ];
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(ctx.weaponFire.get("gun")).toBe(1); // 15 < 20 -> fire
  });

  it("pid converges toward target", () => {
    const rt = createLogicRuntime();
    const ctx = makeCtx();
    const nodes: Node[] = [
      { id: "tgt", type: "constant", params: { value: 10 }, in: {} },
      { id: "sen", type: "sensor_value", params: { part: "sen1" }, in: {} },
      { id: "pid", type: "pid", params: { kp: 0.2, ki: 0.1, kd: 0.05 }, in: { target: "tgt", a: "sen" } },
    ];
    for (let i = 0; i < 30; i++) evalLogic(nodes, rt, ctx, 1 / 60);
    const v = rt.values.get("pid")!.val;
    expect(v).toBeLessThan(0); // 10 < 42 -> negative error -> negative output
  });

  it("toggle flips on rising edge only", () => {
    const rt = createLogicRuntime();
    const ctx = makeCtx();
    const nodes: Node[] = [
      { id: "sig", type: "constant", params: { value: 0 }, in: {} },
      { id: "t", type: "toggle", params: {}, in: { a: "sig" } },
    ];
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(rt.values.get("t")!.val).toBe(0);
    nodes[0]!.params.value = 1;
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(rt.values.get("t")!.val).toBe(1);
    evalLogic(nodes, rt, ctx, 1 / 60); // still held -> no flip
    expect(rt.values.get("t")!.val).toBe(1);
    nodes[0]!.params.value = 0;
    evalLogic(nodes, rt, ctx, 1 / 60);
    evalLogic(nodes, rt, ctx, 1 / 60);
    nodes[0]!.params.value = 1;
    evalLogic(nodes, rt, ctx, 1 / 60);
    expect(rt.values.get("t")!.val).toBe(0); // flipped off
  });
});
