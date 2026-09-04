// SCRAP & STEEL — game/physics.ts
// Planck (Box2D) world construction from a blueprint. One rigid body per part,
// weld joints between adjacent parts (breakable by damage), revolute joints for
// wheels/spinners/servos/turrets, prismatic joints for pistons. Contact
// impulses drive per-part damage.

import planck from "planck-js";
import type { Blueprint } from "./blueprint";
import { partRect, computeAdjacency } from "./blueprint";
import { part, PART_EXTRA, CELL } from "./parts";

export const PPM = 48; // render pixels per meter (art is 32 px per meter, 2x supersample ok)

export interface PartBody {
  partId: string;
  body: planck.Body;
  def: ReturnType<typeof part>;
  hp: number;
  maxHp: number;
  temp: number;
  destroyed: boolean;
  joints: planck.Joint[];
  spinRate: number; // rad/s for weapon discs
}

export interface RobotPhysics {
  bodies: Map<string, PartBody>;
  wheels: { partId: string; joint: planck.RevoluteJoint; radius: number; grip: number; powered: boolean; motorPartId: string | null }[];
  tracks: { partId: string; motorPartId: string | null; grip: number; body: planck.Body }[];
  motors: Map<string, { joint: planck.RevoluteJoint | planck.PrismaticJoint; kind: "drive" | "spinner" | "servo" | "piston" }>;
  weaponParts: Set<string>;
  rootBody: planck.Body | null;
  impactAcc: Map<string, number>;
  world: planck.World;
  bounds: { minX: number; minY: number; w: number; h: number };
}

/** planck-js is pure WASM-free JS — no async init required. Kept for API parity. */
export async function initPhysics(): Promise<void> { /* nothing to load */ }

/** category bits */
const CAT_ROBOT = 0x0002;
const CAT_TERRAIN = 0x0004;
const CAT_PROJECTILE = 0x0008;
const CAT_PART = 0x0010; // loose debris

function shapeFor(def: ReturnType<typeof part>): planck.Shape {
  const w = (def.w * CELL) / 2;
  const h = (def.h * CELL) / 2;
  if (def.shape === "wheel") {
    const r = def.wheel?.radius ?? 0.25;
    return planck.Circle(r);
  }
  if (def.shape === "disc") {
    return planck.Circle(Math.min(w, h));
  }
  if (def.shape === "triL") {
    return planck.Polygon([planck.Vec2(-w, h), planck.Vec2(w, h), planck.Vec2(-w, -h)]);
  }
  if (def.shape === "triR") {
    return planck.Polygon([planck.Vec2(w, h), planck.Vec2(w, -h), planck.Vec2(-w, h)]);
  }
  return planck.Box(w, h);
}

/** Build the physics world for a robot placed with its grid origin at (ox, oy) meters. */
export function buildRobotWorld(world: planck.World, bp: Blueprint, opts: { ox: number; oy?: number; robotBits?: number; groundAlign?: boolean }): RobotPhysics {
  const robotBits = opts.robotBits ?? CAT_ROBOT;
  const phys: RobotPhysics = {
    bodies: new Map(),
    wheels: [],
    tracks: [],
    motors: new Map(),
    weaponParts: new Set(),
    rootBody: null,
    impactAcc: new Map(),
    world,
    bounds: { minX: 0, minY: 0, w: 0, h: 0 },
  };

  const rects = bp.parts.map((p) => ({ p, r: partRect(p) }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { r } of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  phys.bounds = { minX, minY, w: maxX - minX, h: maxY - minY };
  // align the robot's lowest row to the ground unless an explicit oy is given
  const oy = opts.oy ?? (opts.groundAlign ? maxY * CELL + 0.01 : 0);

  // bodies
  for (const { p, r } of rects) {
    const d = part(p.def);
    const cx = (r.x + r.w / 2) * CELL + opts.ox;
    const cy = -(r.y + r.h / 2) * CELL + oy; // physics y-up
    const body = world.createBody({
      type: "dynamic",
      position: planck.Vec2(cx, cy),
      angularDamping: d.wheel ? 0.1 : 0.4,
      linearDamping: 0.02,
    });
    const density = d.mass / (d.w * d.h * CELL * CELL);
    const fixture = body.createFixture(shapeFor(d), {
      density: Math.max(0.2, density),
      friction: d.wheel ? (d.wheel?.grip ?? 1) * 0.85 : 0.55,
      restitution: 0.02,
      filterCategoryBits: robotBits,
      filterMaskBits: 0xffff,
      userData: p.id,
    });
    void fixture;
    phys.bodies.set(p.id, { partId: p.id, body, def: d, hp: d.hp, maxHp: d.hp, temp: 20, destroyed: false, joints: [], spinRate: 0 });
    if (d.weapon) phys.weaponParts.add(p.id);
    if (!phys.rootBody) phys.rootBody = body;
  }

  // structural welds between adjacent parts (skip wheels and free spinners)
  const adj = computeAdjacency(bp);
  const partById = new Map(bp.parts.map((p) => [p.id, p] as const));
  for (const a of adj) {
    const pa = partById.get(a.a)!;
    const pb = partById.get(a.b)!;
    const da = part(pa.def);
    const db = part(pb.def);
    if (da.wheel || db.wheel) continue;
    if (da.weapon?.kind === "spinner" || db.weapon?.kind === "spinner") continue;
    if (PART_EXTRA[pa.def]?.turret || PART_EXTRA[pb.def]?.turret) continue;
    if (PART_EXTRA[pa.def]?.hinge || PART_EXTRA[pb.def]?.hinge) continue;
    const A = phys.bodies.get(a.a)!;
    const B = phys.bodies.get(a.b)!;
    const ma = A.body.getWorldPoint(planck.Vec2(0, 0));
    void ma;
    const anchor = planck.Vec2((A.body.getPosition().x + B.body.getPosition().x) / 2, (A.body.getPosition().y + B.body.getPosition().y) / 2);
    const joint = world.createJoint(planck.WeldJoint({ frequencyHz: 4, dampingRatio: 0.7 }, A.body, B.body, anchor))!;
    A.joints.push(joint);
    B.joints.push(joint);
  }

  // wheels: attach to the nearest structural part at the hub, revolute + motor-ready
  for (const { p } of rects) {
    const d = part(p.def);
    if (!d.wheel) continue;
    const W = phys.bodies.get(p.id)!;
    // find a structural neighbor sharing an edge
    let mount: PartBody | null = null;
    for (const a of adj) {
      const otherId = a.a === p.id ? a.b : a.b === p.id ? a.a : null;
      if (!otherId) continue;
      const od = part(partById.get(otherId)!.def);
      if (od.wheel) continue;
      const ob = phys.bodies.get(otherId);
      if (ob) { mount = ob; break; }
    }
    if (!mount) continue;
    const anchor = planck.Vec2(W.body.getPosition().x, W.body.getPosition().y);
    const joint = world.createJoint(
      planck.RevoluteJoint({ enableMotor: false, motorSpeed: 0, maxMotorTorque: 0 }, mount.body, W.body, anchor),
    ) as planck.RevoluteJoint;
    W.joints.push(joint);
    mount.joints.push(joint);
    phys.wheels.push({ partId: p.id, joint, radius: d.wheel.radius, grip: d.wheel.grip, powered: !!d.wheel.powered, motorPartId: null });
  }

  // drive coupling: each wheel is assigned the NEAREST motor through the weld
  // graph (the chassis is the drivetrain). No motor = the wheel rolls free.
  // Destroying the motor or cutting its welds deassigns the wheel at runtime.
  {
    const weldAdj = new Map<string, string[]>();
    for (const a of adj) {
      if (!weldAdj.has(a.a)) weldAdj.set(a.a, []);
      if (!weldAdj.has(a.b)) weldAdj.set(a.b, []);
      weldAdj.get(a.a)!.push(a.b);
      weldAdj.get(a.b)!.push(a.a);
    }
    for (const w of phys.wheels) {
      // BFS from the wheel to the nearest motor part
      const seen = new Set<string>([w.partId]);
      const q: string[] = [w.partId];
      let motorId: string | null = null;
      while (q.length && !motorId) {
        const cur = q.shift()!;
        for (const n of weldAdj.get(cur) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          const nd = part(partById.get(n)!.def);
          if (nd.motor) { motorId = n; break; }
          q.push(n);
        }
      }
      w.motorPartId = motorId;
      if (motorId) w.joint.enableMotor(true);
    }
  }

  // spinners: revolute to structural mount, motorized
  for (const { p } of rects) {
    const d = part(p.def);
    if (d.weapon?.kind !== "spinner") continue;
    const S = phys.bodies.get(p.id)!;
    let mount: PartBody | null = null;
    for (const a of adj) {
      const otherId = a.a === p.id ? a.b : a.b === p.id ? a.a : null;
      if (!otherId) continue;
      const ob = phys.bodies.get(otherId);
      const od = part(partById.get(otherId)!.def);
      if (ob && !od.wheel && od.weapon?.kind !== "spinner") { mount = ob; break; }
    }
    if (!mount) continue;
    const anchor = planck.Vec2(S.body.getPosition().x, S.body.getPosition().y);
    const joint = world.createJoint(planck.RevoluteJoint({ enableMotor: false, motorSpeed: 0, maxMotorTorque: 60 }, mount.body, S.body, anchor)) as planck.RevoluteJoint;
    S.joints.push(joint);
    mount.joints.push(joint);
    phys.motors.set(p.id, { joint, kind: "spinner" });
  }

  // servos & turrets: position-controlled revolute
  for (const { p } of rects) {
    const d = part(p.def);
    const ex = PART_EXTRA[p.def];
    if (d.servo || ex?.turret || ex?.hinge) {
      const S = phys.bodies.get(p.id)!;
      const others = adj.filter((a) => a.a === p.id || a.b === p.id).map((a) => (a.a === p.id ? a.b : a.a));
      const mountId = others.find((o) => {
        const od = part(partById.get(o)!.def);
        return !od.wheel && od.weapon?.kind !== "spinner";
      });
      const targetId = others.find((o) => o !== mountId);
      if (!mountId || !targetId) continue;
      const M = phys.bodies.get(mountId)!;
      const T = phys.bodies.get(targetId)!;
      // turret: everything welded to target spins; approximate by joining target to mount
      const anchor = planck.Vec2(S.body.getPosition().x, S.body.getPosition().y);
      const joint = world.createJoint(planck.RevoluteJoint({ enableMotor: true, motorSpeed: 0, maxMotorTorque: d.servo?.torque ?? 40, enableLimit: false }, M.body, T.body, anchor)) as planck.RevoluteJoint;
      S.joints.push(joint);
      M.joints.push(joint);
      T.joints.push(joint);
      if (d.servo) phys.motors.set(p.id, { joint, kind: "servo" });
      if (ex?.turret) phys.motors.set(p.id + ":turret", { joint, kind: "servo" });
    }
  }

  // pistons: prismatic joints. The piston part connects to parts on its left/right ends.
  for (const { p } of rects) {
    const d = part(p.def);
    if (!d.piston) continue;
    const S = phys.bodies.get(p.id)!;
    const others = adj.filter((a) => a.a === p.id || a.b === p.id).map((a) => (a.a === p.id ? a.b : a.a));
    const baseId = others[0];
    const headId = others[1];
    if (!baseId || !headId) continue;
    const B = phys.bodies.get(baseId)!;
    const H = phys.bodies.get(headId)!;
    const axis = planck.Vec2(1, 0);
    const anchor = planck.Vec2(S.body.getPosition().x - (d.piston.range / 2), S.body.getPosition().y);
    const joint = world.createJoint(
      planck.PrismaticJoint({ enableMotor: true, motorSpeed: 0, maxMotorForce: d.piston.force, enableLimit: true, lowerTranslation: 0, upperTranslation: d.piston.range }, B.body, H.body, anchor, axis),
    ) as planck.PrismaticJoint;
    S.joints.push(joint);
    phys.motors.set(p.id, { joint, kind: "piston" });
  }

  return phys;
}

export function destroyPartBody(phys: RobotPhysics, partId: string) {
  const pb = phys.bodies.get(partId);
  if (!pb || pb.destroyed) return;
  pb.destroyed = true;
  for (const j of pb.joints) {
    try { phys.world.destroyJoint(j); } catch { /* already gone */ }
  }
  phys.world.destroyBody(pb.body);
}

export function makeProjectile(
  world: planck.World,
  x: number, y: number, vx: number, vy: number, dmg: number, robot: number,
): planck.Body {
  const b = world.createBody({
    type: "dynamic",
    position: planck.Vec2(x, y),
    bullet: true,
    linearVelocity: planck.Vec2(vx, vy),
    gravityScale: dmg > 50 ? 0.25 : 0.55,
  });
  b.createFixture(planck.Circle(0.06), {
    density: 8,
    friction: 0.3,
    restitution: 0.1,
    filterCategoryBits: CAT_PROJECTILE,
    filterMaskBits: 0xffff & ~CAT_PROJECTILE,
    userData: `proj:${robot}:${dmg}`,
  });
  return b;
}

export { CAT_ROBOT, CAT_TERRAIN, CAT_PROJECTILE, CAT_PART };
