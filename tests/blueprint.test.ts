// Blueprint canonicalization + validation tests
import { describe, it, expect } from "vitest";
import { emptyBlueprint, canonicalBlueprint, hashString, preflight, robotStats, computeAdjacency, type Blueprint } from "../src/game/blueprint";
import { PARTS } from "../src/game/parts";

function cart(): Blueprint {
  const bp = emptyBlueprint("t");
  bp.id = "fixed";
  bp.parts = [
    { id: "a", def: "alu_frame", x: 0, y: 0, rot: 0 },
    { id: "b", def: "battery_pack", x: 0, y: -1, rot: 0 },
    { id: "c", def: "micro_controller", x: -1, y: 0, rot: 0 },
    { id: "d", def: "motor_small", x: 0, y: 2, rot: 0 },
    { id: "e", def: "wheel_medium", x: 0, y: 3, rot: 0 },
  ];
  bp.wires = [{ id: "w1", a: { part: "b", port: 0 }, b: { part: "c", port: 0 } }];
  bp.logic = [
    { id: "n1", type: "key_forward", x: 0, y: 0, params: {}, in: {} },
    { id: "n2", type: "motor_power", x: 2, y: 0, params: { part: "d" }, in: { val: "n1" } },
  ];
  return bp;
}

describe("blueprint canonicalization", () => {
  it("same content in different insertion order -> same canonical string", () => {
    const a = cart();
    const b = cart();
    b.parts.reverse();
    expect(canonicalBlueprint(a)).toBe(canonicalBlueprint(b));
  });

  it("different content -> different hash", () => {
    const a = cart();
    const b = cart();
    b.parts[0]!.def = "steel_block";
    expect(hashString(canonicalBlueprint(a))).not.toBe(hashString(canonicalBlueprint(b)));
  });

  it("hashString is deterministic", () => {
    expect(hashString("scrap")).toBe(hashString("scrap"));
    expect(hashString("scrap")).not.toBe(hashString("steel"));
  });

  it("robotStats sums mass/cost/cpu", () => {
    const st = robotStats(cart());
    const alu = PARTS.find((p) => p.id === "alu_frame")!;
    const bat = PARTS.find((p) => p.id === "battery_pack")!;
    expect(st.mass).toBeGreaterThan(alu.mass);
    expect(st.energyKJ).toBe(bat.source!.energyKJ);
    expect(st.cpuProvided).toBeGreaterThanOrEqual(8);
    expect(st.cpuUsed).toBe(2);
  });

  it("adjacency finds edge-touching parts only", () => {
    const adj = computeAdjacency(cart());
    // battery (-1 row) touches frame; motor touches frame; wheel touches motor
    const pairs = adj.map((a) => [a.a, a.b].sort().join("|"));
    expect(pairs).toContain("a|b");
    expect(pairs).toContain("a|d");
    expect(pairs).toContain("d|e");
    expect(pairs).not.toContain("b|e");
  });

  it("preflight flags missing controller and mass overload", () => {
    const bp = cart();
    bp.parts = bp.parts.filter((p) => p.def !== "micro_controller");
    const items = preflight(bp, 1500);
    expect(items.some((i) => !i.ok && /controller/i.test(i.text))).toBe(true);
    const heavy = cart();
    heavy.parts = heavy.parts.filter((p) => p.def !== "alu_frame");
    for (let i = 0; i < 20; i++) heavy.parts.push({ id: `x${i}`, def: "ballast", x: i % 10, y: Math.floor(i / 10) * 2, rot: 0 });
    const items2 = preflight(heavy, 1500);
    expect(items2.some((i) => !i.ok && /Mass/.test(i.text))).toBe(true);
  });
});
