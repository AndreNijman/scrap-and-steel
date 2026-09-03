// Protocol validation tests: malformed payloads never reach simulation code.
import { describe, it, expect } from "vitest";
import { encode, parseEnvelope, sanitizePayload, PROTOCOL_VERSION } from "../shared/protocol";

describe("protocol", () => {
  it("round-trips a valid envelope", () => {
    const raw = encode("input_frame", { tick: 120, throttle: 1, steer: -0.5, fire: true });
    const env = parseEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.t).toBe("input_frame");
    expect(env!.v).toBe(PROTOCOL_VERSION);
    expect((env!.payload as { tick: number }).tick).toBe(120);
  });

  it("rejects malformed JSON", () => {
    expect(parseEnvelope("{not json")).toBeNull();
  });

  it("rejects wrong protocol version", () => {
    expect(parseEnvelope(JSON.stringify({ v: 99, t: "ping" }))).toBeNull();
  });

  it("rejects non-string or missing type", () => {
    expect(parseEnvelope(JSON.stringify({ v: 1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ v: 1, t: 42 }))).toBeNull();
  });

  it("rejects oversized messages", () => {
    const huge = JSON.stringify({ v: 1, t: "ping", payload: "x".repeat(300 * 1024) });
    expect(parseEnvelope(huge)).toBeNull();
  });

  it("sanitizePayload rejects NaN and Infinity anywhere in the tree", () => {
    expect(sanitizePayload({ a: 1, b: "x", c: [1, 2, 3] })).toBe(true);
    expect(sanitizePayload({ a: Number.NaN })).toBe(false);
    expect(sanitizePayload({ a: [1, { b: Number.POSITIVE_INFINITY }] })).toBe(false);
    expect(sanitizePayload({ deep: { deeper: { x: Number.NaN } } })).toBe(false);
  });

  it("ignores unknown message types safely (parse still succeeds; dispatch decides)", () => {
    const env = parseEnvelope(JSON.stringify({ v: 1, t: "future_thing", payload: {} }));
    expect(env).not.toBeNull();
    expect(env!.t).toBe("future_thing");
  });
});
