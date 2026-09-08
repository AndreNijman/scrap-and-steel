import { it, expect } from "vitest";
import { compilePython } from "../src/game/python";

it("python drive program populates motor outputs", () => {
  const src = `drive = clamp(forward() - back(), -1, 1)\nmotor("m1", drive)\nmotor("m2", drive)`;
  const res = compilePython(src);
  console.log("compile:", res.ok ? "OK" : res.error);
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
  console.log("motorPowers:", [...motorPowers.entries()]);
  expect(motorPowers.get("m1")).toBe(1);
  expect(motorPowers.get("m2")).toBe(1);
});
