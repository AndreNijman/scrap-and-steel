// SCRAP AND STEEL — sim/robot.ts
// Runtime assembly for one robot: bodies, welds, wheels, weapons, heat, damage.
// Built strictly from an immutable Blueprint snapshot. Runtime values NEVER flow
// back into blueprint data (Test Bay invariant).

import type { Blueprint, InputChannel } from "../blueprint/types";
import { PART_DEFS, type PartDef } from "../content/parts";
import { CELL } from "../blueprint/types";
import { PhysicsWorld, type PhysicsHandle, type RAPIER } from "./adapter";
import type { PowerNet, WireState } from "./power";

export interface PartRuntime {
  partId: string;
  def: PartDef;
  body: PhysicsHandle;
  hp: number;
  maxHp: number;
  temp: number;
  destroyed: boolean;
  welds: string[]; // weld ids touching this part
  spinOmega: number; // current angular speed for weapons (rad/s)
}

export interface WeldRuntime {
  id: string;
  a: string; // part id
  b: string;
  hp: number;
  maxHp: number;
  joint: RAPIER.ImpulseJoint;
}

export interface WheelRuntime {
  wheelPartId: string;
  motorPartId: string;
  body: PhysicsHandle;
  joint: RAPIER.ImpulseJoint;
  axle: [number, number, number];
  sideSign: number; // -1 left, +1 right relative to robot forward
}

export interface WeaponRuntime {
  partId: string;
  body: PhysicsHandle;
  joint: RAPIER.ImpulseJoint;
  def: PartDef;
  omega: number;
  axis: [number, number, number];
}

export interface LifterRuntime {
  partId: string;
  body: PhysicsHandle;
  def: PartDef;
  cooldown: number;
}

export interface RobotInput {
  throttle: number; // -1..1
  steer: number; // -1..1
  fire: boolean;
  lift: boolean;
}

export function newRobotInput(): RobotInput {
  return { throttle: 0, steer: 0, fire: false, lift: false };
}

export class RobotRuntime {
  bp: Blueprint;
  side: 0 | 1;
  parts = new Map<string, PartRuntime>();
  welds = new Map<string, WeldRuntime>();
  wheels: WheelRuntime[] = [];
  weapons: WeaponRuntime[] = [];
  lifters: LifterRuntime[] = [];
  cores: string[] = [];
  batteries = new Map<string, { energyKJ: number; peakW: number; heatCoef: number; def: PartDef }>();
  controllers = new Set<string>();
  channels = new Map<string, InputChannel[]>(); // partId -> bound channels
  charge = 1; // 0..1 fraction of total battery energy
  input: RobotInput = newRobotInput();
  lastPowerNet: PowerNet | null = null;
  lastResult: { mobility: boolean; offense: boolean; control: boolean; destroyed: boolean } = { mobility: false, offense: false, control: false, destroyed: false };
  destroyedTimer = 0;
  isDestroyed = false;

  constructor(bp: Blueprint, side: 0 | 1) {
    this.bp = bp;
    this.side = side;
  }

  aliveParts(): Set<string> {
    const s = new Set<string>();
    for (const [id, p] of this.parts) if (!p.destroyed) s.add(id);
    return s;
  }

  totalMass(): number {
    let m = 0;
    for (const p of this.parts.values()) if (!p.destroyed) m += p.def.mass;
    return m;
  }
}

export interface SpawnOpts {
  offset: [number, number, number]; // world offset of robot local origin
  yaw: number; // facing radians
  group: number;
}

// shape helpers -----------------------------------------------------------

function defHalfExtents(def: PartDef): [number, number, number] {
  return [(def.size[0] * CELL) / 2, (def.size[1] * CELL) / 2, (def.size[2] * CELL) / 2];
}

function rotY(quatOut: [number, number, number, number], steps: number): void {
  const a = (steps * Math.PI) / 2;
  quatOut[0] = 0;
  quatOut[1] = Math.sin(a / 2);
  quatOut[2] = 0;
  quatOut[3] = Math.cos(a / 2);
}

/**
 * Spawn every part of the blueprint as its own rigid body, connect adjacent parts
 * with fixed (weld) joints, wheels with revolute joints, and return the runtime.
 */
export function spawnRobot(pw: PhysicsWorld, bp: Blueprint, side: 0 | 1, opts: SpawnOpts): RobotRuntime {
  const rt = new RobotRuntime(bp, side);
  const cos = Math.cos(opts.yaw);
  const sin = Math.sin(opts.yaw);
  const toWorld = (x: number, y: number, z: number): [number, number, number] => [
    opts.offset[0] + x * cos + z * sin,
    opts.offset[1] + y,
    opts.offset[2] - x * sin + z * cos,
  ];

  const spawnQuat: [number, number, number, number] = [0, 0, 0, 1];

  // ---- bodies ----
  for (const p of bp.parts) {
    const def = PART_DEFS[p.defId];
    if (!def) continue;
    const [hx, hy, hz] = defHalfExtents(def);
    const cy = def.shape === "wheel" ? hy : hy; // wheels sit with center at pos
    const wx = p.pos[0] * CELL;
    const wy = p.pos[1] * CELL + cy;
    const wz = p.pos[2] * CELL;
    rotY(spawnQuat, p.rot);
    // compose yaw
    const yawQ: [number, number, number, number] = [0, Math.sin(opts.yaw / 2), 0, Math.cos(opts.yaw / 2)];
    const q = quatMul(yawQ, spawnQuat);
    const world = toWorld(wx, wy, wz);
    const ccd = def.weapon?.kind === "spinner" || def.weapon?.kind === "saw";
    let body: PhysicsHandle;
    if (def.shape === "wheel") {
      const radius = Math.max(hx, hz) + 0.06; // slightly larger than cell half-height so the chassis clears the ground
      body = pw.createBody({
        pos: world,
        rotQuat: q,
        shape: { kind: "cylinder", halfHeight: hy, radius, axis: axleFor(p.rot) },
        mass: def.mass,
        friction: frictionFor(def),
        restitution: 0.05,
        ccd: false,
        group: opts.group,
      });
    } else if (def.shape === "spinner_drum") {
      body = pw.createBody({
        pos: world,
        rotQuat: q,
        shape: { kind: "cylinder", halfHeight: hz, radius: hy, axis: [1, 0, 0] },
        mass: def.mass,
        friction: 0.5,
        restitution: 0.1,
        ccd: true,
        group: opts.group,
      });
    } else if (def.shape === "wedge") {
      const pts = wedgePoints(hx, hy, hz);
      body = pw.createBody({
        pos: world,
        rotQuat: q,
        shape: { kind: "convex", points: pts },
        mass: def.mass,
        friction: 0.7,
        restitution: 0.05,
        ccd: false,
        group: opts.group,
      });
    } else {
      body = pw.createBody({
        pos: world,
        rotQuat: q,
        shape: { kind: "box", hx, hy, hz },
        mass: def.mass,
        friction: frictionFor(def),
        restitution: 0.05,
        ccd,
        group: opts.group,
      });
    }
    rt.parts.set(p.id, {
      partId: p.id,
      def,
      body,
      hp: def.hp,
      maxHp: def.hp,
      temp: 25,
      destroyed: false,
      welds: [],
      spinOmega: 0,
    });
    if (def.source) rt.batteries.set(p.id, { energyKJ: def.source.energy, peakW: def.source.peakW, heatCoef: def.source.heatCoef ?? 1, def });
    if (def.controller) rt.controllers.add(p.id);
    if (def.id === "control_core") rt.cores.push(p.id);
  }

  // ---- adjacency welds (wheels and free-spinning weapons are NEVER welded:
  //      they need revolute mounts or they cannot rotate) ----
  const partsArr = bp.parts.filter((p) => rt.parts.has(p.id));
  for (let i = 0; i < partsArr.length; i++) {
    for (let j = i + 1; j < partsArr.length; j++) {
      const a = partsArr[i]!;
      const b = partsArr[j]!;
      const da = PART_DEFS[a.defId];
      const db = PART_DEFS[b.defId];
      if (da?.shape === "wheel" || db?.shape === "wheel") continue;
      if (da?.weapon?.kind === "spinner" || db?.weapon?.kind === "spinner") continue;
      const face = touchingFace(a, b, rt);
      if (!face) continue;
      const ra = rt.parts.get(a.id)!;
      const rb = rt.parts.get(b.id)!;
      // shared anchor: midpoint between the two body origins (near the interface)
      const ta = ra.body.translation();
      const tb = rb.body.translation();
      const mid: [number, number, number] = [(ta.x + tb.x) / 2, (ta.y + tb.y) / 2, (ta.z + tb.z) / 2];
      const joint = pw.weld({
        a: ra.body,
        b: rb.body,
        anchorA: worldToLocalPoint(ra.body, mid),
        anchorB: worldToLocalPoint(rb.body, mid),
      });
      const weldId = `w_${a.id}_${b.id}`;
      const maxHp = Math.min(ra.maxHp, rb.maxHp) * 1.5;
      rt.welds.set(weldId, { id: weldId, a: a.id, b: b.id, hp: maxHp, maxHp, joint });
      ra.welds.push(weldId);
      rb.welds.push(weldId);
    }
  }

  // ---- wheels on motors (adjacency drive couplings) ----
  for (const p of partsArr) {
    const def = PART_DEFS[p.defId];
    if (def?.shape !== "wheel") continue;
    for (const other of partsArr) {
      const od = PART_DEFS[other.defId];
      if (!od?.motor) continue;
      const face = touchingFace(p, other, rt);
      if (!face) continue;
      const wheel = rt.parts.get(p.id)!;
      const motor = rt.parts.get(other.id)!;
      // axle is the wheel's local x axis, transformed into world then into motor local frame
      const axisWorld = rotateY90([1, 0, 0], p.rot, opts.yaw);
      const tw = wheel.body.translation();
      const joint = pw.revolute({
        a: motor.body,
        b: wheel.body,
        anchor1: worldToLocalPoint(motor.body, [tw.x, tw.y, tw.z]),
        anchor2: [0, 0, 0], // wheel spins about its own center
        axis: worldDirToLocalPoint(motor.body, axisWorld),
      });
      const sideSign = Math.sign(p.pos[0] || 1);
      rt.wheels.push({
        wheelPartId: p.id,
        motorPartId: other.id,
        body: wheel.body,
        joint,
        axle: axisWorld,
        sideSign,
      });
    }
  }

  // ---- weapons: free-spinning bodies attached via revolute to their mount ----
  for (const p of partsArr) {
    const def = PART_DEFS[p.defId];
    if (!def?.weapon || def.weapon.kind === "saw") continue;
    const wep = rt.parts.get(p.id)!;
    // find a non-wheel structural neighbor to mount on
    let mount: (typeof partsArr)[number] | null = null;
    for (const other of partsArr) {
      if (other.id === p.id) continue;
      const od = PART_DEFS[other.defId];
      if (od?.shape === "wheel") continue;
      if (touchingFace(p, other, rt)) {
        mount = other;
        break;
      }
    }
    if (!mount) continue;
    const axisLocal: [number, number, number] =
      def.shape === "spinner_drum" ? [1, 0, 0] : [0, 1, 0]; // drum spins about long axis; bar about vertical
    const axisWorld = rotateY90(axisLocal, p.rot, opts.yaw);
    const tw = wep.body.translation();
    const joint = pw.revolute({
      a: rt.parts.get(mount.id)!.body,
      b: wep.body,
      anchor1: worldToLocalPoint(rt.parts.get(mount.id)!.body, [tw.x, tw.y, tw.z]),
      anchor2: [0, 0, 0],
      axis: worldDirToLocalPoint(rt.parts.get(mount.id)!.body, axisWorld),
    });
    rt.weapons.push({ partId: p.id, body: wep.body, joint, def, omega: 0, axis: axisWorld });
  }

  // saws & lifters are rigidly mounted (already welded); just register lifters
  for (const p of partsArr) {
    const def = PART_DEFS[p.defId];
    if (def?.lifter) {
      rt.lifters.push({ partId: p.id, body: rt.parts.get(p.id)!.body, def, cooldown: 0 });
    }
  }

  // ---- bindings ----
  for (const b of bp.bindings) {
    const list = rt.channels.get(b.targetPartId) ?? [];
    list.push(b.channel);
    rt.channels.set(b.targetPartId, list);
  }

  return rt;
}

function frictionFor(def: PartDef): number {
  if (def.shape === "wheel") {
    if (def.id === "wheel_pneumatic") return 1.5;
    if (def.id === "wheel_hard") return 0.95;
    return 1.25;
  }
  return 0.6;
}

function axleFor(rot: number): [number, number, number] {
  // wheels are cylinders whose axis is x in local space; rotY rotates around y so x-axis stays x
  void rot;
  return [1, 0, 0];
}

export function wedgePoints(hx: number, hy: number, hz: number): number[] {
  // triangular prism: slope rising toward +z
  return [
    -hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, // bottom
    -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, // back (tall) face at -z
  ];
}

interface FaceHit {
  normal: [number, number, number];
}

/** Grid-space adjacency: faces touch with overlap on the other two axes.
 *  Positions are min corners in cells; compare face-to-face using centers. */
export function touchingFace(
  a: { id: string; pos: [number, number, number]; defId: string },
  b: { id: string; pos: [number, number, number]; defId: string },
  rt: RobotRuntime,
): FaceHit | null {
  const da = rt.parts.get(a.id)?.def ?? PART_DEFS[a.defId];
  const db = rt.parts.get(b.id)?.def ?? PART_DEFS[b.defId];
  if (!da || !db) return null;
  const sa = [da.size[0], da.size[1], da.size[2]];
  const sb = [db.size[0], db.size[1], db.size[2]];
  const d = [
    b.pos[0] + sb[0]! / 2 - (a.pos[0] + sa[0]! / 2),
    b.pos[1] + sb[1]! / 2 - (a.pos[1] + sa[1]! / 2),
    b.pos[2] + sb[2]! / 2 - (a.pos[2] + sa[2]! / 2),
  ];
  const eps = 0.15; // cells of tolerance for face contact
  // try each axis as the contact axis
  for (let axis = 0; axis < 3; axis++) {
    const need = (sa[axis]! + sb[axis]!) / 2;
    const gap = Math.abs(d[axis]!) - need;
    if (Math.abs(gap) > eps) continue;
    // overlap on the other two axes?
    let ok = true;
    for (let o = 0; o < 3; o++) {
      if (o === axis) continue;
      if (Math.abs(d[o]!) >= (sa[o]! + sb[o]!) / 2 - 0.15) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = d[axis]! > 0 ? 1 : -1;
    return { normal };
  }
  return null;
}

function rotateY90(v: [number, number, number], steps: number, yaw: number): [number, number, number] {
  let [x, y, z] = v;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) {
    const nx = z;
    const nz = -x;
    x = nx;
    z = nz;
  }
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, y, -x * s + z * c];
}

function quatMul(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Body-local anchor: inverse-rotate (worldPoint - bodyTranslation) into the body frame. */
export function worldToLocalPoint(body: PhysicsHandle, worldPos: [number, number, number]): [number, number, number] {
  const t = body.translation();
  const r = body.rotation();
  const dx = worldPos[0] - t.x;
  const dy = worldPos[1] - t.y;
  const dz = worldPos[2] - t.z;
  return quatInverseRotate([r.x, r.y, r.z, r.w], [dx, dy, dz]);
}

/** Body-local direction: inverse-rotate a world-space direction. */
export function worldDirToLocalPoint(body: PhysicsHandle, dir: [number, number, number]): [number, number, number] {
  const r = body.rotation();
  return quatInverseRotate([r.x, r.y, r.z, r.w], dir);
}

export function quatInverseRotate(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
  // apply inverse rotation: conjugate quaternion (for unit q)
  const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Wire states view for this robot's wires (used by power solver each solve). */
export function collectWireStates(_rt: RobotRuntime, net: PowerNet | null): Map<string, WireState> {
  const m = new Map<string, WireState>();
  if (!net) return m;
  for (const w of net.wires.values()) m.set(w.id, w);
  return m;
}
