// SCRAP AND STEEL — sim/adapter.ts
// PhysicsAdapter around Rapier 3D (compat WASM build). Keep engine specifics behind
// this interface so the engine choice stays reversible (roadmap M0 bake-off rule).

import RAPIER from "@dimforge/rapier3d-compat";

export type PhysicsHandle = RAPIER.RigidBody;
export { RAPIER };

let initialized = false;
export async function initPhysics(): Promise<void> {
  if (initialized) return;
  await RAPIER.init();
  initialized = true;
}

export interface BodyDesc {
  pos: [number, number, number];
  rotQuat: [number, number, number, number];
  shape:
    | { kind: "box"; hx: number; hy: number; hz: number }
    | { kind: "cylinder"; halfHeight: number; radius: number; axis: [number, number, number] }
    | { kind: "convex"; points: number[] };
  mass: number;
  friction: number;
  restitution: number;
  ccd: boolean;
  group: number; // collision group bits
}

export interface WeldDesc {
  a: PhysicsHandle;
  b: PhysicsHandle;
  anchorA: [number, number, number];
  anchorB: [number, number, number];
}

export interface RevoluteDesc {
  a: PhysicsHandle; // chassis part
  b: PhysicsHandle; // wheel / weapon
  anchor1: [number, number, number]; // joint point in a's local frame
  anchor2: [number, number, number]; // joint point in b's local frame
  axis: [number, number, number]; // axis in a's local frame
  limits?: [number, number];
}

export class PhysicsWorld {
  world: RAPIER.World;
  eventQueue = new RAPIER.EventQueue(true);
  private cumulativeImpulse = new Map<PhysicsHandle, number>();

  constructor(gravity = -9.81) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = 1 / 60;
  }

  createBody(desc: BodyDesc): PhysicsHandle {
    const rb = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(...desc.pos)
        .setRotation({ x: desc.rotQuat[0], y: desc.rotQuat[1], z: desc.rotQuat[2], w: desc.rotQuat[3] })
        .setLinearDamping(0.05)
        .setAngularDamping(0.08)
        .setCcdEnabled(desc.ccd),
    );
    let cd: RAPIER.ColliderDesc;
    if (desc.shape.kind === "box") {
      cd = RAPIER.ColliderDesc.cuboid(desc.shape.hx, desc.shape.hy, desc.shape.hz);
    } else if (desc.shape.kind === "cylinder") {
      // Rapier cylinders are y-axis; rotate via collider rotation if needed
      cd = RAPIER.ColliderDesc.cylinder(desc.shape.halfHeight, desc.shape.radius);
      const axis = desc.shape.axis;
      if (Math.abs(axis[1]) < 0.9) {
        // rotate collider so its y axis aligns with the requested axis
        const q = quatFromUnitVectors([0, 1, 0], axis);
        cd = cd.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
      }
    } else {
      cd = RAPIER.ColliderDesc.convexHull(new Float32Array(desc.shape.points))!;
    }
    cd.setMass(desc.mass).setFriction(desc.friction).setRestitution(desc.restitution);
    cd.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.world.createCollider(cd, rb);
    return rb;
  }

  createStaticBox(pos: [number, number, number], hx: number, hy: number, hz: number, friction = 0.9): PhysicsHandle {
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...pos));
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction);
    this.world.createCollider(cd, rb);
    return rb;
  }

  weld(desc: WeldDesc): RAPIER.ImpulseJoint {
    const jd = RAPIER.JointData.fixed(
      { x: desc.anchorA[0], y: desc.anchorA[1], z: desc.anchorA[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: desc.anchorB[0], y: desc.anchorB[1], z: desc.anchorB[2] },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    return this.world.createImpulseJoint(jd, desc.a, desc.b, true);
  }

  revolute(desc: RevoluteDesc): RAPIER.ImpulseJoint {
    const jd = RAPIER.JointData.revolute(
      { x: desc.anchor1[0], y: desc.anchor1[1], z: desc.anchor1[2] },
      { x: desc.anchor2[0], y: desc.anchor2[1], z: desc.anchor2[2] },
      { x: desc.axis[0], y: desc.axis[1], z: desc.axis[2] },
    );
    if (desc.limits) jd.limitsEnabled = true, (jd.limits = desc.limits);
    return this.world.createImpulseJoint(jd, desc.a, desc.b, true);
  }

  removeJoint(j: RAPIER.ImpulseJoint) {
    this.world.removeImpulseJoint(j, true);
  }

  removeBody(b: PhysicsHandle) {
    this.world.removeRigidBody(b);
  }

  /** Fixed 60 Hz step + collect contact forces as per-body impulse damage estimates. */
  step(dt: number): Map<PhysicsHandle, number> {
    this.world.timestep = dt;
    this.cumulativeImpulse.clear();
    this.lastContactPairs = [];
    this.world.step(this.eventQueue);
    this.eventQueue.drainContactForceEvents((ev) => {
      const f = ev.totalForceMagnitude();
      this.addImpulse(ev.collider1(), f);
      this.addImpulse(ev.collider2(), f);
      this.lastContactPairs.push({ a: ev.collider1(), b: ev.collider2(), force: f });
    });
    return this.cumulativeImpulse;
  }

  lastContactPairs: { a: number; b: number; force: number }[] = [];

  private addImpulse(collider: number, f: number) {
    const col = this.world.getCollider(collider);
    if (!col) return;
    const parent = col.parent();
    if (!parent) return;
    const cur = this.cumulativeImpulse.get(parent) ?? 0;
    this.cumulativeImpulse.set(parent, cur + f);
  }
  contactPairs(): { a: number; b: number; force: number }[] {
    return this.lastContactPairs;
  }

  destroy() {
    this.world.free();
  }
}

export function quatFromAxisAngle(axis: [number, number, number], angle: number): { x: number; y: number; z: number; w: number } {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2);
  return { x: (axis[0] / l) * s, y: (axis[1] / l) * s, z: (axis[2] / l) * s, w: Math.cos(angle / 2) };
}

export function quatFromUnitVectors(a: [number, number, number], b: [number, number, number]): [number, number, number, number] {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.999) return [0, 1, 0, 0];
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  const w = 1 + dot;
  const len = Math.hypot(cx, cy, cz, w) || 1;
  return [cx / len, cy / len, cz / len, w / len];
}

/** Seeded PRNG (mulberry32) — no Math.random() in authoritative match logic. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
