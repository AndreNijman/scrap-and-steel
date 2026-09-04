// SCRAP & STEEL — game/logic.ts
// Visual logic system. Nodes form a directed graph evaluated every sim tick.
// The player builds drive mixes, auto-aim, battery management — anything —
// from inputs, math, flow and outputs. No hidden behaviours.

export type NodeCategory = "input" | "logic" | "flow" | "output";

export interface LogicNodeDef {
  type: string;
  name: string;
  cat: NodeCategory;
  desc: string;
  inputs: string[]; // ordered input port names
  params?: { key: string; label: string; kind: "number" | "select" | "target"; options?: string[] }[];
  outputs: string[];
}

export const NODE_DEFS: Record<string, LogicNodeDef> = {
  // ---- inputs (player keys + virtual keys used by bots) ----
  key_forward: { type: "key_forward", name: "INPUT FORWARD", cat: "input", desc: "1 while forward key (W / bot drive-forward) is held.", inputs: [], outputs: ["val"] },
  key_back: { type: "key_back", name: "INPUT REVERSE", cat: "input", desc: "1 while reverse key (S / bot drive-back) is held.", inputs: [], outputs: ["val"] },
  key_fire: { type: "key_fire", name: "INPUT TRIGGER", cat: "input", desc: "1 while fire key (SPACE / bot trigger) is held.", inputs: [], outputs: ["val"] },
  key_aux: { type: "key_aux", name: "INPUT AUX", cat: "input", desc: "1 while aux key (SHIFT / bot aux) is held.", inputs: [], outputs: ["val"] },
  key_turret: { type: "key_turret", name: "INPUT TURRET", cat: "input", desc: "Turret turn axis: -1 (CCW) .. +1 (CW). Keys Q/E.", inputs: [], outputs: ["val"] },
  // ---- sensors (bound to sensor parts) ----
  sensor_value: {
    type: "sensor_value", name: "SENSOR", cat: "input", desc: "Live reading of a wired sensor part.",
    inputs: [], outputs: ["val"],
    params: [{ key: "part", label: "Sensor part", kind: "target", options: ["sensor"] }],
  },
  constant: { type: "constant", name: "CONSTANT", cat: "input", desc: "Fixed number.", inputs: [], outputs: ["val"], params: [{ key: "value", label: "Value", kind: "number" }] },
  // ---- logic ----
  and: { type: "and", name: "AND", cat: "logic", desc: "1 if both inputs are non-zero.", inputs: ["a", "b"], outputs: ["val"] },
  or: { type: "or", name: "OR", cat: "logic", desc: "1 if either input is non-zero.", inputs: ["a", "b"], outputs: ["val"] },
  not: { type: "not", name: "NOT", cat: "logic", desc: "1 if input is zero.", inputs: ["a"], outputs: ["val"] },
  xor: { type: "xor", name: "XOR", cat: "logic", desc: "1 if inputs differ.", inputs: ["a", "b"], outputs: ["val"] },
  gt: { type: "gt", name: "GREATER", cat: "logic", desc: "1 if a > b.", inputs: ["a", "b"], outputs: ["val"] },
  lt: { type: "lt", name: "LESS", cat: "logic", desc: "1 if a < b.", inputs: ["a", "b"], outputs: ["val"] },
  eq: { type: "eq", name: "EQUAL", cat: "logic", desc: "1 if |a-b| < epsilon.", inputs: ["a", "b"], outputs: ["val"] },
  add: { type: "add", name: "ADD", cat: "logic", desc: "a + b", inputs: ["a", "b"], outputs: ["val"] },
  sub: { type: "sub", name: "SUBTRACT", cat: "logic", desc: "a - b", inputs: ["a", "b"], outputs: ["val"] },
  mul: { type: "mul", name: "MULTIPLY", cat: "logic", desc: "a * b", inputs: ["a", "b"], outputs: ["val"] },
  div: { type: "div", name: "DIVIDE", cat: "logic", desc: "a / b (0 if b = 0)", inputs: ["a", "b"], outputs: ["val"] },
  abs: { type: "abs", name: "ABSOLUTE", cat: "logic", desc: "|a|", inputs: ["a"], outputs: ["val"] },
  clamp: { type: "clamp", name: "CLAMP", cat: "logic", desc: "Clamp a to [min, max].", inputs: ["a"], outputs: ["val"], params: [{ key: "min", label: "Min", kind: "number" }, { key: "max", label: "Max", kind: "number" }] },
  // ---- flow ----
  select: { type: "select", name: "IF / ELSE", cat: "flow", desc: "cond ≠ 0 → a, else b.", inputs: ["cond", "a", "b"], outputs: ["val"] },
  toggle: { type: "toggle", name: "TOGGLE", cat: "flow", desc: "Flips output on rising edge of a.", inputs: ["a"], outputs: ["val"] },
  latch: { type: "latch", name: "LATCH", cat: "flow", desc: "set a → 1 until reset b.", inputs: ["a", "b"], outputs: ["val"] },
  timer: { type: "timer", name: "TIMER", cat: "flow", desc: "Square wave: seconds on, seconds off.", inputs: [], outputs: ["val"], params: [{ key: "on", label: "On (s)", kind: "number" }, { key: "off", label: "Off (s)", kind: "number" }] },
  delay: { type: "delay", name: "DELAY", cat: "flow", desc: "Delays a by n seconds.", inputs: ["a"], outputs: ["val"], params: [{ key: "sec", label: "Seconds", kind: "number" }] },
  counter: { type: "counter", name: "COUNTER", cat: "flow", desc: "Counts rising edges of a, wraps at max.", inputs: ["a"], outputs: ["val"], params: [{ key: "max", label: "Wrap at", kind: "number" }] },
  pid: { type: "pid", name: "PID", cat: "flow", desc: "PID controller. target - a drives output.", inputs: ["target", "a"], outputs: ["val"], params: [{ key: "kp", label: "Kp", kind: "number" }, { key: "ki", label: "Ki", kind: "number" }, { key: "kd", label: "Kd", kind: "number" }] },
  // ---- outputs (bound to actuator parts) ----
  motor_power: {
    type: "motor_power", name: "MOTOR POWER", cat: "output", desc: "Drives a motor: -1 .. +1 of its rated torque.",
    inputs: ["val"], outputs: [],
    params: [{ key: "part", label: "Motor part", kind: "target", options: ["motor"] }],
  },
  servo_target: {
    type: "servo_target", name: "SERVO TARGET", cat: "output", desc: "Sets a servo/piston target: input is degrees (-90..90) or 0..1 extension.",
    inputs: ["val"], outputs: [],
    params: [{ key: "part", label: "Servo / turret / piston part", kind: "target", options: ["servo", "turret", "piston"] }],
  },
  weapon_fire: {
    type: "weapon_fire", name: "WEAPON TRIGGER", cat: "output", desc: "1 fires the bound weapon (if powered + ammo).",
    inputs: ["val"], outputs: [],
    params: [{ key: "part", label: "Weapon part", kind: "target", options: ["weapon"] }],
  },
  brake: {
    type: "brake", name: "BRAKE", cat: "output", desc: "1 locks all driven wheels.",
    inputs: ["val"], outputs: [],
  },
};

export const NODE_TYPES_BY_CAT: Record<NodeCategory, string[]> = {
  input: ["key_forward", "key_back", "key_fire", "key_aux", "key_turret", "sensor_value", "constant"],
  logic: ["and", "or", "not", "xor", "gt", "lt", "eq", "add", "sub", "mul", "div", "abs", "clamp"],
  flow: ["select", "toggle", "latch", "timer", "delay", "counter", "pid"],
  output: ["motor_power", "servo_target", "weapon_fire", "brake"],
};

export interface LogicNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, string | number>;
  in: Record<string, string | null>;
}

export interface LogicRuntime {
  values: Map<string, Record<string, number>>;
  toggleState: Map<string, number>;
  latchState: Map<string, number>;
  lastInput: Map<string, number>;
  delayBuf: Map<string, { buf: number[]; t: number }>;
  counterState: Map<string, { count: number; last: number }>;
  pidState: Map<string, { integ: number; lastErr: number }>;
  tick: number;
}

export function createLogicRuntime(): LogicRuntime {
  return { values: new Map(), toggleState: new Map(), latchState: new Map(), lastInput: new Map(), delayBuf: new Map(), counterState: new Map(), pidState: new Map(), tick: 0 };
}

export interface LogicContext {
  /** read an input value for node type key (virtual keyboard / bot keys) */
  keys: { forward: number; back: number; fire: number; aux: number; turret: number };
  /** sensor reading by part instance id */
  readSensor: (partId: string) => number;
  /** outputs collected during eval */
  motorPowers: Map<string, number>; // partId -> -1..1
  servoTargets: Map<string, number>; // partId -> degrees
  weaponFire: Map<string, number>; // partId -> 0/1
  brake: number;
}

export function evalLogic(
  nodes: { id: string; type: string; params: Record<string, string | number>; in: Record<string, string | null> }[],
  rt: LogicRuntime,
  ctx: LogicContext,
  dt: number,
) {
  rt.tick++;
  ctx.motorPowers.clear();
  ctx.servoTargets.clear();
  ctx.weaponFire.clear();
  ctx.brake = 0;

  const read = (nodeId: string | null | undefined, port: string): number => {
    if (!nodeId) return 0;
    const outs = rt.values.get(nodeId);
    if (!outs) return 0;
    return outs[port] ?? 0;
  };

  // evaluate in insertion order; nodes may reference later nodes (previous tick value)
  for (const n of nodes) {
    const def = NODE_DEFS[n.type];
    if (!def) continue;
    const outs: Record<string, number> = {};
    const a = read(n.in.a, "val");
    const b = read(n.in.b, "val");
    const cond = read(n.in.cond, "val");
    const target = read(n.in.target, "val");
    switch (n.type) {
      case "key_forward": outs.val = ctx.keys.forward; break;
      case "key_back": outs.val = ctx.keys.back; break;
      case "key_fire": outs.val = ctx.keys.fire; break;
      case "key_aux": outs.val = ctx.keys.aux; break;
      case "key_turret": outs.val = ctx.keys.turret; break;
      case "sensor_value": outs.val = ctx.readSensor(String(n.params.part ?? "")); break;
      case "constant": outs.val = Number(n.params.value ?? 0); break;
      case "and": outs.val = a !== 0 && b !== 0 ? 1 : 0; break;
      case "or": outs.val = a !== 0 || b !== 0 ? 1 : 0; break;
      case "not": outs.val = a === 0 ? 1 : 0; break;
      case "xor": outs.val = a !== 0 !== (b !== 0) ? 1 : 0; break;
      case "gt": outs.val = a > b ? 1 : 0; break;
      case "lt": outs.val = a < b ? 1 : 0; break;
      case "eq": outs.val = Math.abs(a - b) < 0.001 ? 1 : 0; break;
      case "add": outs.val = a + b; break;
      case "sub": outs.val = a - b; break;
      case "mul": outs.val = a * b; break;
      case "div": outs.val = Math.abs(b) < 1e-9 ? 0 : a / b; break;
      case "abs": outs.val = Math.abs(a); break;
      case "clamp": outs.val = Math.max(Number(n.params.min ?? 0), Math.min(Number(n.params.max ?? 1), a)); break;
      case "select": outs.val = cond !== 0 ? a : b; break;
      case "toggle": {
        const last = rt.lastInput.get(n.id) ?? 0;
        if (last === 0 && a !== 0) rt.toggleState.set(n.id, rt.toggleState.get(n.id) === 1 ? 0 : 1);
        rt.lastInput.set(n.id, a);
        outs.val = rt.toggleState.get(n.id) ?? 0;
        break;
      }
      case "latch": {
        if (a !== 0) rt.latchState.set(n.id, 1);
        if (b !== 0) rt.latchState.set(n.id, 0);
        outs.val = rt.latchState.get(n.id) ?? 0;
        break;
      }
      case "timer": {
        const on = Math.max(0.05, Number(n.params.on ?? 1));
        const off = Math.max(0.05, Number(n.params.off ?? 1));
        const t = rt.tick * dt;
        outs.val = t % (on + off) < on ? 1 : 0;
        break;
      }
      case "delay": {
        const sec = Math.max(0.05, Number(n.params.sec ?? 0.5));
        let buf = rt.delayBuf.get(n.id);
        if (!buf) { buf = { buf: [], t: 0 }; rt.delayBuf.set(n.id, buf); }
        buf.buf.push(a);
        const need = Math.max(1, Math.round(sec / dt));
        while (buf.buf.length > need) buf.buf.shift();
        outs.val = buf.buf.length >= need ? buf.buf[0]! : 0;
        break;
      }
      case "counter": {
        const max = Math.max(1, Number(n.params.max ?? 10));
        let st = rt.counterState.get(n.id);
        if (!st) { st = { count: 0, last: 0 }; rt.counterState.set(n.id, st); }
        if (st.last === 0 && a !== 0) st.count = (st.count + 1) % max;
        st.last = a;
        outs.val = st.count;
        break;
      }
      case "pid": {
        const kp = Number(n.params.kp ?? 2);
        const ki = Number(n.params.ki ?? 0.2);
        const kd = Number(n.params.kd ?? 0.4);
        let st = rt.pidState.get(n.id);
        if (!st) { st = { integ: 0, lastErr: 0 }; rt.pidState.set(n.id, st); }
        const err = target - a;
        st.integ = Math.max(-10, Math.min(10, st.integ + err * dt));
        const deriv = (err - st.lastErr) / Math.max(dt, 1e-6);
        st.lastErr = err;
        outs.val = Math.max(-1, Math.min(1, kp * err + ki * st.integ + kd * deriv));
        break;
      }
      case "motor_power": {
        const v = read(n.in.val, "val");
        const partId = String(n.params.part ?? "");
        if (partId) ctx.motorPowers.set(partId, Math.max(-1, Math.min(1, v)));
        break;
      }
      case "servo_target": {
        const v = read(n.in.val, "val");
        const partId = String(n.params.part ?? "");
        if (partId) ctx.servoTargets.set(partId, v);
        break;
      }
      case "weapon_fire": {
        const v = read(n.in.val, "val");
        const partId = String(n.params.part ?? "");
        if (partId && v !== 0) ctx.weaponFire.set(partId, 1);
        break;
      }
      case "brake": {
        if (read(n.in.val, "val") !== 0) ctx.brake = 1;
        break;
      }
      default: break;
    }
    rt.values.set(n.id, outs);
  }
}
