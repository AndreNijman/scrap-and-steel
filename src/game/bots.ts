// SCRAP & STEEL — game/bots.ts
// Bot opponents use real blueprints (parts + wires + logic) and set virtual keys
// through the same input path as the player. Difficulty improves decision
// making — reaction time, aim discipline, positioning — never stats.
//
// Layout rule: side view, y grows DOWN, ground = row below the lowest part.
// forward = +x. Nothing may overlap; motors must touch their wheels.

import type { Blueprint, PlacedPart, Wire, LogicNode } from "./blueprint";
import { uid } from "./blueprint";
import type { BotDriver, RobotView } from "./sim";
export type BotSpec = { id: string; name: string; desc: string; difficulty: number; build: () => Blueprint };

function part(def: string, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0): PlacedPart {
  return { id: uid("p"), def, x, y, rot };
}
function wire(aPart: PlacedPart, aPort: number, bPart: PlacedPart, bPort: number): Wire {
  return { id: uid("w"), a: { part: aPart.id, port: aPort }, b: { part: bPart.id, port: bPort } };
}
function node(type: string, x: number, y: number, params: Record<string, string | number> = {}): LogicNode {
  return { id: uid("n"), type, x, y, params, in: {} };
}
function base(parts: PlacedPart[], wires: Wire[], logic: LogicNode[], name: string): Blueprint {
  return { version: 2, id: uid("bp"), name, parts, wires, logic };
}
function driveLogic(logic: LogicNode[], targets: string[], label: string) {
  const kf = node("key_forward", 0, 0);
  const kb = node("key_back", 0, 2);
  const mix = node("sub", 2, 0);
  mix.in.a = kf.id;
  mix.in.b = kb.id;
  const cl = node("clamp", 4, 0, { min: -1, max: 1 });
  cl.in.a = mix.id;
  for (const t of targets) {
    const out = node("motor_power", 6, 0, { part: t });
    out.in.val = cl.id;
    logic.push(out);
  }
  logic.push(kf, kb, mix, cl);
  void label;
}

/** SCOUT — fast, light, fragile. 2 racing wheels. */
export const SCOUT: BotSpec = {
  id: "scout", name: "SCOUT", desc: "Fast, lightly armoured, highly mobile.", difficulty: 0.25,
  build: () => {
    const parts: PlacedPart[] = [];
    const wires: Wire[] = [];
    const logic: LogicNode[] = [];
    // hull row (y0..2): frame is the chassis
    const frame = part("alu_frame", 1, 0); parts.push(frame); // x1..3, y0..2
    const nose = part("steel_block", 0, 1); parts.push(nose); // x0..1, y1..2
    const wedge = part("tri_brace", 0, 2); parts.push(wedge); // x0..1, y2..3
    const skirt = part("arm_light", 0, 0); parts.push(skirt); // x0..1, y0..1
    // electronics on top (y-1)
    const bat = part("battery_pack", 1, -1); parts.push(bat); // x1..3, y-1..0
    const cpu = part("micro_controller", 0, -1); parts.push(cpu); // x0..1, y-1..0
    const enc = part("sen_encoder", 3, -1); parts.push(enc); // x3..4, y-1..0
    // motors + wheels (bottom)
    const m1 = part("motor_speed", 1, 2); parts.push(m1); // x1..3, y2..3
    const m2 = part("motor_speed", 3, 2); parts.push(m2); // x3..5, y2..3
    const w1 = part("wheel_racing", 1, 3); parts.push(w1);
    const w2 = part("wheel_racing", 3, 3); parts.push(w2);
    // wiring: battery -> everything
    wires.push(wire(bat, 0, cpu, 0));
    wires.push(wire(bat, 0, m1, 0));
    wires.push(wire(m1, 2, m2, 0));
    wires.push(wire(bat, 0, enc, 0));
    // drive logic
    driveLogic(logic, [m1.id, m2.id], "scout");
    return base(parts, wires, logic, "SCOUT MK-I");
  },
};

/** TANK — slow, armoured, auto-aiming cannon on tracks. */
export const TANK: BotSpec = {
  id: "tank", name: "TANK", desc: "Slow, heavily armoured, powerful cannon.", difficulty: 0.5,
  build: () => {
    const parts: PlacedPart[] = [];
    const wires: Wire[] = [];
    const logic: LogicNode[] = [];
    // hull (y0..2)
    const f1 = part("heavy_frame", 1, 0); parts.push(f1); // x1..3
    const f2 = part("heavy_frame", 3, 0); parts.push(f2); // x3..5
    const nose = part("arm_sloped", 0, 1); parts.push(nose); // x0..1, y1..2
    const tail = part("arm_hardened", 5, 1); parts.push(tail); // x5..6, y1..2
    // hull top row (y-1..0): camera on the nose column, vertical battery + cpu on the tail column.
    // NOTHING in the turret column x2..3 except the bearing.
    const bat = part("battery_hd", 5, -1); parts.push(bat); // x5..6, y-1..1 (vertical, against f2's right edge)
    const cpu = part("logic_processor", 6, 0); parts.push(cpu); // x6..7, y0..1
    const cam = part("sen_camera", 0, 0); parts.push(cam); // x0..1, y0..1 (radar-class sensor)
    // turret stack: bearing (x2..3, y-2..0) -> breech -> barrel + ammo (rotate together)
    const bearing = part("turret_bearing", 2, -2); parts.push(bearing); // x2..3, y-2..0
    const breech = part("gun_breech", 2, -3); parts.push(breech); // x2..3, y-3..-2
    const barrel = part("gun_barrel_l", 3, -3); parts.push(barrel); // x3..6, y-3..-2
    const ammo = part("ammo_box", 0, -3); parts.push(ammo); // x0..2, y-3..-2
    // tracks (y2..4)
    const t1 = part("track_unit", 1, 2); parts.push(t1);
    const t2 = part("track_unit", 3, 2); parts.push(t2);
    // wiring
    wires.push(wire(bat, 0, cpu, 0));
    wires.push(wire(bat, 0, t1, 0));
    wires.push(wire(bat, 0, t2, 0));
    wires.push(wire(bat, 0, bearing, 0));
    wires.push(wire(bat, 0, cam, 0));
    wires.push(wire(bat, 2, breech, 0));
    // breech power: battery right port -> breech left port (long run)
    wires.push(wire(bat, 2, breech, 0));
    // logic: drive + auto-aim (PID on radar bearing) + fire in range
    driveLogic(logic, [t1.id, t2.id], "tank");
    const bearingS = node("sensor_value", 0, 4, { part: bearing.id + "#bearing" });
    const pid = node("pid", 2, 4, { kp: 0.04, ki: 0.002, kd: 0.01 });
    pid.in.a = bearingS.id;
    const servoOut = node("servo_target", 4, 4, { part: bearing.id });
    servoOut.in.val = pid.id;
    const rangeS = node("sensor_value", 0, 6, { part: cam.id + "#range" });
    const c24 = node("constant", 2, 6, { value: 26 });
    const close = node("lt", 4, 6);
    close.in.a = rangeS.id;
    close.in.b = c24.id;
    const trig = node("weapon_fire", 6, 6, { part: breech.id });
    trig.in.val = close.id;
    logic.push(bearingS, pid, servoOut, rangeS, c24, close, trig);
    return base(parts, wires, logic, "IRONHIDE");
  },
};

/** BERSERKER — aggressive close-range spinner brute. */
export const BERSERKER: BotSpec = {
  id: "berserker", name: "BERSERKER", desc: "Aggressive close-range spinner brute.", difficulty: 0.4,
  build: () => {
    const parts: PlacedPart[] = [];
    const wires: Wire[] = [];
    const logic: LogicNode[] = [];
    // hull
    const f1 = part("steel_block", 1, 1); parts.push(f1); // x1..2, y1..2
    const f2 = part("heavy_frame", 2, 1); parts.push(f2); // x2..4, y1..2
    const wedge = part("arm_sloped", 0, 2); parts.push(wedge); // x0..1, y2..3
    // top electronics
    const cpu = part("micro_controller", 2, 0); parts.push(cpu); // x2..3, y0..1
    const bat = part("battery_hd", 3, 0); parts.push(bat); // x3..4, y0..2
    // spinner: industrial motor on a rear mast, disc above it (revolute mount)
    const spinMotor = part("motor_industrial", 4, -1); parts.push(spinMotor); // x4..6, y-1..1
    const disc = part("spinner_disc_w", 4, -3); parts.push(disc); // x4..6, y-3..-1
    // proximity sensor front
    const prox = part("sen_proximity", 0, 0); parts.push(prox); // x0..1, y0..1
    // drive: 2 torque motors + large wheels
    const m1 = part("motor_torque", 1, 2); parts.push(m1); // x1..3, y2..3
    const m2 = part("motor_torque", 3, 2); parts.push(m2); // x3..5, y2..3 — overlaps spinMotor? spinMotor y-1..1 no ✓
    const w1 = part("wheel_large", 1, 3); parts.push(w1);
    const w2 = part("wheel_large", 3, 3); parts.push(w2);
    // wiring
    wires.push(wire(bat, 0, cpu, 0));
    wires.push(wire(bat, 0, spinMotor, 0));
    wires.push(wire(bat, 0, m1, 0));
    wires.push(wire(m1, 2, m2, 0));
    wires.push(wire(bat, 0, prox, 0));
    // logic: spinner always on + charge forward
    const one = node("constant", 0, 0, { value: 1 });
    const spin = node("weapon_fire", 2, 0, { part: disc.id });
    spin.in.val = one.id;
    const kf = node("key_forward", 0, 2);
    const cl = node("clamp", 2, 2, { min: 0, max: 1 });
    cl.in.a = kf.id;
    for (const m of [m1, m2]) {
      const out = node("motor_power", 4, 2, { part: m.id });
      out.in.val = cl.id;
      logic.push(out);
    }
    logic.push(one, spin, kf, cl);
    return base(parts, wires, logic, "RAVAGER");
  },
};

/** ARTILLERY — long-range railgun platform, keeps distance. */
export const ARTILLERY: BotSpec = {
  id: "artillery", name: "ARTILLERY", desc: "Long-range weapon platform. Keeps distance.", difficulty: 0.65,
  build: () => {
    const parts: PlacedPart[] = [];
    const wires: Wire[] = [];
    const logic: LogicNode[] = [];
    // hull (y1..2), 4 frames so the top row has room clear of the bearing column x2..3
    const f1 = part("heavy_frame", 1, 1); parts.push(f1); // x1..3
    const f2 = part("heavy_frame", 3, 1); parts.push(f2); // x3..5
    const f3 = part("heavy_frame", 5, 1); parts.push(f3); // x5..7
    const f4 = part("heavy_frame", 7, 1); parts.push(f4); // x7..9
    const tail = part("arm_composite", 9, 2); parts.push(tail); // x9..10, y2..3
    // top row (y-1..0), clear of bearing column x2..3
    const gen = part("generator", 7, -1); parts.push(gen); // x7..9, y-1..1
    const bat = part("battery_hd", 4, -1); parts.push(bat); // x4..5, y-1..1
    const cap = part("capacitor", 5, -1); parts.push(cap); // x5..6, y-1..0
    const cpu = part("advanced_cpu", 8, -1); parts.push(cpu); // x8..10, y-1..0
    // railgun column x2..3
    const bearing = part("turret_bearing", 2, -2); parts.push(bearing); // x2..3, y-2..0
    const rail = part("railgun", 2, -4); parts.push(rail); // x2..5, y-4..-2
    // drive
    const m1 = part("motor_torque", 1, 2); parts.push(m1); // x1..3, y2..3
    const m2 = part("motor_torque", 3, 2); parts.push(m2); // x3..5, y2..3
    const w1 = part("wheel_offroad", 1, 3); parts.push(w1);
    const w2 = part("wheel_offroad", 3, 3); parts.push(w2);
    // radar-class camera on the nose (hull-mounted, clear of bearing)
    const cam = part("sen_camera", 0, 0); parts.push(cam); // x0..1, y0..1
    // wiring
    wires.push(wire(gen, 0, bat, 0));
    wires.push(wire(bat, 0, cap, 0));
    wires.push(wire(bat, 0, cpu, 0));
    wires.push(wire(bat, 0, bearing, 0));
    wires.push(wire(bat, 0, rail, 0));
    wires.push(wire(bat, 0, m1, 0));
    wires.push(wire(m1, 2, m2, 0));
    wires.push(wire(gen, 0, cam, 0));
    // logic: keep distance 16-26, auto-aim, fire
    driveLogic(logic, [m1.id, m2.id], "arty");
    const rangeS = node("sensor_value", 0, 4, { part: cam.id + "#range" });
    const c16 = node("constant", 2, 4, { value: 16 });
    const c26 = node("constant", 2, 6, { value: 26 });
    const tooClose = node("lt", 4, 4); tooClose.in.a = rangeS.id; tooClose.in.b = c16.id;
    const tooFar = node("gt", 4, 6); tooFar.in.a = rangeS.id; tooFar.in.b = c26.id;
    const kf = node("key_forward", 0, 8);
    const kb = node("key_back", 0, 10);
    const back = node("select", 6, 4); back.in.cond = tooClose.id; back.in.a = kb.id; back.in.b = kf.id;
    const fwd = node("select", 6, 8); fwd.in.cond = tooFar.id; fwd.in.a = kf.id; fwd.in.b = kb.id;
    const clB = node("clamp", 8, 4, { min: 0, max: 1 }); clB.in.a = back.id;
    const clF = node("clamp", 8, 8, { min: 0, max: 1 }); clF.in.a = fwd.id;
    for (const m of [m1, m2]) {
      const outB = node("motor_power", 10, 4, { part: m.id });
      outB.in.val = clB.id;
      logic.push(outB);
    }
    const bearingS = node("sensor_value", 0, 12, { part: bearing.id + "#bearing" });
    const pid = node("pid", 2, 12, { kp: 0.04, ki: 0.002, kd: 0.01 });
    pid.in.a = bearingS.id;
    const servoOut = node("servo_target", 4, 12, { part: bearing.id });
    servoOut.in.val = pid.id;
    const c38 = node("constant", 2, 14, { value: 38 });
    const inRange = node("lt", 4, 14); inRange.in.a = rangeS.id; inRange.in.b = c38.id;
    const trig = node("weapon_fire", 6, 14, { part: rail.id });
    trig.in.val = inRange.id;
    logic.push(rangeS, c16, c26, tooClose, tooFar, kf, kb, back, fwd, clB, clF, bearingS, pid, servoOut, c38, inRange, trig);
    return base(parts, wires, logic, "LONGSHOT");
  },
};

/** EXPERIMENTAL — pneumatic hopper. */
export const EXPERIMENTAL: BotSpec = {
  id: "experimental", name: "EXPERIMENTAL", desc: "Unusual mechanism. Nobody knows what it does.", difficulty: 0.55,
  build: () => {
    const parts: PlacedPart[] = [];
    const wires: Wire[] = [];
    const logic: LogicNode[] = [];
    // hull
    const frame = part("alu_frame", 1, 0); parts.push(frame); // x1..3, y0..2
    const nose = part("steel_block", 0, 1); parts.push(nose);
    const cpu = part("logic_processor", 0, 0); parts.push(cpu); // x0..1, y0..1
    const bat = part("battery_pack", 1, -1); parts.push(bat); // x1..3, y-1..0
    const comp = part("compressor", 3, 0); parts.push(comp); // x3..5, y0..1
    // pneumatic piston below rear, kicking down (hop)
    const tank = part("air_tank", 1, 2); parts.push(tank); // x1..2, y2..3
    const piston = part("pneumatic_piston", 2, 2); parts.push(piston); // x2..4, y2..3
    // wheel
    const m = part("motor_torque", 4, 2); parts.push(m); // x4..6, y2..3
    const w = part("wheel_large", 4, 3); parts.push(w);
    // wiring
    wires.push(wire(bat, 0, cpu, 0));
    wires.push(wire(bat, 0, comp, 0));
    wires.push(wire(comp, 0, tank, 0));
    wires.push(wire(tank, 0, piston, 0));
    wires.push(wire(bat, 0, m, 0));
    // logic: timer pumps the piston (hop), drive forward
    const timer = node("timer", 0, 0, { on: 0.4, off: 1.4 });
    const pOut = node("servo_target", 2, 0, { part: piston.id });
    pOut.in.val = timer.id;
    const kf = node("key_forward", 0, 2);
    const out = node("motor_power", 2, 2, { part: m.id });
    out.in.val = kf.id;
    logic.push(timer, pOut, kf, out);
    return base(parts, wires, logic, "WHAT-IS-THAT");
  },
};

export const BOT_SPECS: BotSpec[] = [SCOUT, TANK, BERSERKER, ARTILLERY, EXPERIMENTAL];

// ---------------- drivers ----------------

export class DriverBot implements BotDriver {
  difficulty: number;
  private timer = 0;
  private reaction = 0;
  private lastDecision = { forward: 0, back: 0, fire: 0 };
  constructor(difficulty: number) {
    this.difficulty = difficulty;
    this.reaction = 0.55 - difficulty * 0.4;
  }
  update(self: RobotView, enemy: RobotView | null, inputs: { forward: number; back: number; fire: number; aux: number; turret: number }, dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.reaction * (0.7 + Math.random() * 0.6);
      if (!enemy || enemy.destroyed) {
        this.lastDecision = { forward: 0, back: 0, fire: 0 };
      } else {
        const dx = enemy.x - self.x;
        const dir = Math.sign(dx) || 1;
        const dist = Math.abs(dx);
        const aimOk = Math.sign(self.facing) === dir;
        this.lastDecision = {
          forward: aimOk ? 1 : 0,
          back: !aimOk ? 1 : 0,
          fire: dist < 26 && Math.random() < 0.3 + this.difficulty * 0.5 ? 1 : 0,
        };
      }
    }
    inputs.forward = this.lastDecision.forward;
    inputs.back = this.lastDecision.back;
    inputs.fire = this.lastDecision.fire;
    inputs.aux = 0;
  }
}
