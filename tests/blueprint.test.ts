// Blueprint canonicalization tests (release gate: same blueprint => same hash).
import { describe, it, expect } from "vitest";
import { canonicalize, blueprintHash } from "../src/blueprint/canonical";
import { emptyBlueprint, type Blueprint } from "../src/blueprint/types";

function bpWith(parts: Blueprint["parts"], wires: Blueprint["wires"] = []): Blueprint {
  const bp = emptyBlueprint("t");
  bp.id = "fixed-test-id"; // stable id: it is part of the hash
  bp.parts = parts;
  bp.wires = wires;
  return bp;
}

describe("blueprint canonicalization", () => {
  it("produces identical hashes for equivalent blueprints with different insertion order", () => {
    const a = bpWith([
      { id: "p2", defId: "frame_tube", pos: [1, 0, 0], rot: 0 },
      { id: "p1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 },
    ]);
    const b = bpWith([
      { id: "p1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 },
      { id: "p2", defId: "frame_tube", pos: [1, 0, 0], rot: 0 },
    ]);
    expect(blueprintHash(a)).toBe(blueprintHash(b));
  });

  it("changes the hash when content changes", () => {
    const a = bpWith([{ id: "p1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 }]);
    const b = bpWith([{ id: "p1", defId: "armor_steel", pos: [0, 0, 0], rot: 0 }]);
    expect(blueprintHash(a)).not.toBe(blueprintHash(b));
  });

  it("hashes wires regardless of order", () => {
    const w1 = { id: "w1", from: "a", to: "b", gauge: "medium" as const };
    const w2 = { id: "w2", from: "b", to: "c", gauge: "light" as const };
    const a = bpWith(
      [
        { id: "a", defId: "battery_compact", pos: [0, 0, 0], rot: 0 },
        { id: "b", defId: "motor_compact", pos: [1, 0, 0], rot: 0 },
        { id: "c", defId: "wheel_rubber", pos: [2, 0, 0], rot: 0 },
      ],
      [w1, w2],
    );
    const b = bpWith(
      [
        { id: "a", defId: "battery_compact", pos: [0, 0, 0], rot: 0 },
        { id: "b", defId: "motor_compact", pos: [1, 0, 0], rot: 0 },
        { id: "c", defId: "wheel_rubber", pos: [2, 0, 0], rot: 0 },
      ],
      [w2, w1],
    );
    expect(blueprintHash(a)).toBe(blueprintHash(b));
  });

  it("canonicalize() is stable under repeated application", () => {
    const a = bpWith([
      { id: "p2", defId: "frame_tube", pos: [1, 0, 0], rot: 2 },
      { id: "p1", defId: "frame_tube", pos: [0, 0, 0], rot: 1 },
    ]);
    expect(canonicalize(canonicalize(a))).toEqual(canonicalize(a));
  });

  it("does not leak runtime values into blueprints (type-level guard test)", () => {
    // Blueprint must serialize to JSON without temperature/charge/damage keys
    const bp = emptyBlueprint("clean");
    const s = JSON.stringify(canonicalize(bp));
    expect(s).not.toMatch(/temperature|charge|damage|velocity|hp/);
  });
});
