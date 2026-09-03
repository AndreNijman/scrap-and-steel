// SCRAP AND STEEL — sim/simulation.ts
// Deterministic fixed-60Hz match simulation. Two robots, arena, damage, heat,
// power, defeat evaluation. Same blueprint + same seed + same inputs => same
// outcome (modulo floating-point; corrected via authority snapshots).

import type { Blueprint } from "../blueprint/types";
import { PART_DEFS, type PartDef } from "../content/parts";
import { PhysicsWorld, makeRng, quatFromAxisAngle, type PhysicsHandle, RAPIER } from "./adapter";
import {
  spawnRobot,
  RobotRuntime,
  newRobotInput,
  type RobotInput,
} from "./robot";
import { solvePower, type PowerNet, type LoadRequest } from "./power";
import { evaluateDefeat } from "./defeat";
import type { ArenaDef } from "../content/parts";

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

export interface MatchSeedConfig {
  seed: number;
  arena: ArenaDef;
}

export type MatchOutcome =
  | { kind: "ko"; winner: 0 | 1 | null; reason: string }
  | { kind: "timeout"; winner: null; reason: "time-limit" }
  | null;

export interface SimDebugInfo {
  tick: number;
  robots: {
    mass: number;
    charge: number;
    demandW: number;
    deliveredW: number;
    hottest: { name: string; temp: number } | null;
    mobility: boolean;
    offense: boolean;
    control: boolean;
    destroyedTimer: number;
    partsAlive: number;
    partsTotal: number;
  }[];
}

export interface SimEvents {
  onPartDestroyed?: (side: 0 | 1, partId: string, defId: string) => void;
  onWeldBroken?: (side: 0 | 1, a: string, b: string) => void;
  onBigHit?: (side: 0 | 1, partId: string, force: number) => void;
}

const DAMAGE_SCALE = 0.008; // impulse (N·s-ish from force magnitude) -> hp
const DAMAGE_MIN_FORCE = 6000; // resting/driving contact and mild internal slams must never grind parts down
const WELD_DAMAGE_SHARE = 0.6;
const HEAT_GEN_FULL_LOAD = 9; // degC/s at 100% load
const HEAT_PASSIVE_COOL = 0.05; // per second per degC above ambient
const AMBIENT = 25;
const OVERHEAT_DERATE = 110;
const OVERHEAT_SHUTDOWN = 145;
const OVERHEAT_DAMAGE = 170;

export class MatchSimulation {
  pw: PhysicsWorld;
  robots: [RobotRuntime, RobotRuntime];
  tick = 0;
  rng: () => number;
  arena: ArenaDef;
  outcome: MatchOutcome = null;
  events: SimEvents = {};
  /** Set when the match ends; the client may unfreeze briefly for a slow-mo beat. */
  frozen = false;
  destroyedCount: [number, number] = [0, 0];
  private powerNets: [PowerNet | null, PowerNet | null] = [null, null];
  private defeatTimer = 0;
  private staticBodies: PhysicsHandle[] = [];

  constructor(bpA: Blueprint, bpB: Blueprint, cfg: MatchSeedConfig) {
    this.pw = new PhysicsWorld();
    this.rng = makeRng(cfg.seed);
    this.arena = cfg.arena;
    this.buildArena(cfg.arena);
    this.robots = [
      spawnRobot(this.pw, bpA, 0, { offset: [0, 0.08, cfg.arena.half * 0.55], yaw: Math.PI, group: 0 }),
      spawnRobot(this.pw, bpB, 1, { offset: [0, 0.08, -cfg.arena.half * 0.55], yaw: 0, group: 0 }),
    ];
  }

  private buildArena(arena: ArenaDef) {
    const pw = this.pw;
    const h = arena.half;
    const floor = pw.createStaticBox([0, -0.5, 0], h + 2, 0.5, h + 2, 0.95);
    this.staticBodies.push(floor);
    const t = 0.5;
    const wallH = arena.wallH;
    this.staticBodies.push(pw.createStaticBox([0, wallH / 2, h + t], h + 2, wallH, t));
    this.staticBodies.push(pw.createStaticBox([0, wallH / 2, -h - t], h + 2, wallH, t));
    this.staticBodies.push(pw.createStaticBox([h + t, wallH / 2, 0], t, wallH, h + 2));
    this.staticBodies.push(pw.createStaticBox([-h - t, wallH / 2, 0], t, wallH, h + 2));
    if (arena.ramps) {
      // two low ramps near the side walls (static rotated boxes)
      for (const sx of [-1, 1]) {
        const rb = this.pw.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(sx * (h - 2.2), 0.35, 0)
            .setRotation(quatFromAxisAngle([0, 0, 1], (sx * Math.PI) / 12)),
        );
        const cd = RAPIER.ColliderDesc.cuboid(1.2, 0.12, 2.4).setFriction(0.9);
        this.pw.world.createCollider(cd, rb);
        this.staticBodies.push(rb);
      }
    }
  }

  /** Apply one fixed step. inputs: per-side control state. */
  step(inputs: [RobotInput, RobotInput]) {
    if (this.frozen) return;
    this.tick++;
    const dt = TICK_DT;

    this.robots[0].input = inputs[0];
    this.robots[1].input = inputs[1];

    // power solve at 15 Hz
    if (this.tick % 4 === 1) {
      for (let side = 0 as 0 | 1; side <= 1; side++) {
        this.powerNets[side] = this.solvePowerFor(this.robots[side], this.powerNets[side], dt * 4);
      }
    }

    // controls -> forces
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      this.applyControls(this.robots[side], dt);
    }

    // physics
    const impulses = this.pw.step(dt);

    // damage from contact forces
    this.applyDamage(impulses);

    // heat
    this.applyHeat(dt);

    // battery drain from last power solve
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const net = this.powerNets[side];
      const rt = this.robots[side];
      if (!net || net.totalDeliveredW <= 0) continue;
      const capKJ = totalCapacityKJ(rt);
      rt.charge = Math.max(0, rt.charge - (net.totalDeliveredW * dt) / 1000 / capKJ);
    }

    // defeat evaluation at 2 Hz
    this.defeatTimer += dt;
    if (this.defeatTimer >= 0.5) {
      this.defeatTimer = 0;
      this.evaluateDefeat();
    }
  }

  private solvePowerFor(rt: RobotRuntime, prev: PowerNet | null, dt: number): PowerNet {
    const alive = rt.aliveParts();
    // a part functions only if weld-connected to a surviving control core
    const functional = this.functionalParts(rt);
    const intactWires = new Set<string>();
    for (const w of rt.bp.wires) {
      if (!alive.has(w.from) || !alive.has(w.to)) continue;
      intactWires.add(w.id);
    }
    const requests: LoadRequest[] = [];
    const inp = rt.input;
    for (const p of rt.parts.values()) {
      if (p.destroyed || !functional.has(p.partId)) continue;
      const def = p.def;
      if (def.motor) {
        const chans = rt.channels.get(p.partId) ?? [];
        const drive = chans.includes("throttle") || chans.includes("steer");
        const load = drive ? Math.abs(inp.throttle) + Math.abs(inp.steer) * 0.5 : 0;
        if (load > 0.01) requests.push({ partId: p.partId, watts: def.motor.peakW * Math.min(load, 1) });
      } else if (def.weapon) {
        // weapons spin up when fire is bound or held; keep spinning at idle draw once armed
        const armed = rt.input.fire || p.spinOmega > 2;
        if (armed) requests.push({ partId: p.partId, watts: def.weapon.peakW });
      } else if (def.lifter) {
        if (rt.input.lift && rt.channels.get(p.partId)?.includes("lift")) {
          requests.push({ partId: p.partId, watts: def.lifter.peakW });
        }
      } else if (def.cooling && def.cooling.drawW > 0) {
        requests.push({ partId: p.partId, watts: def.cooling.drawW });
      }
    }
    // battery energy gating: model empty batteries by removing their peak capacity
    const aliveIds = new Set(rt.bp.parts.filter((p) => !rt.parts.get(p.id)?.destroyed).map((p) => p.id));
    const anyCharge = rt.charge > 0.001;
    return solvePower(rt.bp, anyCharge ? aliveIds : new Set([...aliveIds].filter((id) => !rt.batteries.has(id))), intactWires, requests, prev, dt);
  }

  /** Parts weld-connected to a surviving control core (functionality requirement). */
  functionalParts(rt: RobotRuntime): Set<string> {
    const alive = rt.aliveParts();
    const adj = new Map<string, string[]>();
    for (const [id, p] of rt.parts) {
      if (p.destroyed) continue;
      adj.set(id, []);
    }
    for (const w of rt.welds.values()) {
      if (!adj.has(w.a) || !adj.has(w.b)) continue;
      adj.get(w.a)!.push(w.b);
      adj.get(w.b)!.push(w.a);
    }
    const out = new Set<string>();
    const q: string[] = [];
    for (const c of rt.cores) {
      const part = rt.parts.get(c);
      if (part && !part.destroyed) {
        q.push(c);
        out.add(c);
      }
    }
    while (q.length) {
      const cur = q.shift()!;
      for (const n of adj.get(cur) ?? []) {
        if (!out.has(n)) {
          out.add(n);
          q.push(n);
        }
      }
    }
    void alive;
    return out;
  }

  private applyControls(rt: RobotRuntime, dt: number) {
    const net = this.powerNets[rt.side];
    const inp = rt.input;
    const functional = this.functionalParts(rt);

    // drive wheels via torque impulses (reaction applied to chassis for wheelies)
    for (const wheel of rt.wheels) {
      const motor = rt.parts.get(wheel.motorPartId);
      const wheelPart = rt.parts.get(wheel.wheelPartId);
      if (!motor || !wheelPart || motor.destroyed || wheelPart.destroyed) continue;
      if (!functional.has(wheel.motorPartId)) continue;
      const chans = rt.channels.get(wheel.motorPartId) ?? [];
      const hasThrottle = chans.includes("throttle");
      const hasSteer = chans.includes("steer");
      if (!hasThrottle && !hasSteer) continue;
      const loadState = net?.loads.get(wheel.motorPartId);
      const powered = loadState?.powered ?? false;
      const regulated = loadState?.regulated ?? false;
      const derate = powered ? (regulated ? 1 : 0.6) : 0;
      const thermal = motor.temp > OVERHEAT_SHUTDOWN ? 0 : motor.temp > OVERHEAT_DERATE ? 0.5 : 1;
      const cmd = inp.throttle + inp.steer * wheel.sideSign;
      const clamped = Math.max(-1, Math.min(1, cmd));
      const maxOmega = (motor.def.motor!.maxRpm * 2 * Math.PI) / 60;
      const wheelOmega = wheel.body.angvel();
      // project angular velocity onto axle for feedback
      const cur = wheelOmega.x * wheel.axle[0] + wheelOmega.y * wheel.axle[1] + wheelOmega.z * wheel.axle[2];
      const target = clamped * maxOmega;
      const err = target - cur;
      let torque = err * motor.def.motor!.torque * 0.35;
      const maxTorque = motor.def.motor!.torque * derate * thermal;
      torque = Math.max(-maxTorque, Math.min(maxTorque, torque));
      if (Math.abs(torque) > 1e-4) {
        const imp = torque * dt;
        wheel.body.applyTorqueImpulse({ x: imp * wheel.axle[0], y: imp * wheel.axle[1], z: imp * wheel.axle[2] }, true);
        // partial reaction on the chassis (full reaction makes every bot wheelie nonstop)
        const react = imp * 0.25;
        motor.body.applyTorqueImpulse({ x: -react * wheel.axle[0], y: -react * wheel.axle[1], z: -react * wheel.axle[2] }, true);
      }
    }

    // weapons
    for (const wep of rt.weapons) {
      const part = rt.parts.get(wep.partId);
      if (!part || part.destroyed || !functional.has(wep.partId)) continue;
      const loadState = net?.loads.get(wep.partId);
      const powered = loadState?.powered ?? false;
      const regulated = loadState?.regulated ?? false;
      const deliverScale = powered ? (regulated ? 1 : 0.6) : 0;
      const thermal = part.temp > OVERHEAT_SHUTDOWN ? 0 : part.temp > OVERHEAT_DERATE ? 0.5 : 1;
      if (inp.fire) {
        // drive weapon angular velocity toward the target along its axis
        const targetOmega = (wep.def.weapon!.spinupRpm * 2 * Math.PI) / 60;
        const accel = 8; // rad/s^2 at full power
        wep.omega = Math.min(targetOmega, wep.omega + accel * deliverScale * thermal * dt);
        const curW = wep.body.angvel();
        const curProj = curW.x * wep.axis[0] + curW.y * wep.axis[1] + curW.z * wep.axis[2];
        const sign = curProj >= 0 ? 1 : -1;
        const nextProj = Math.min(Math.abs(curProj) + accel * deliverScale * thermal * dt, wep.omega);
        const add = (nextProj - Math.abs(curProj)) * sign;
        wep.body.setAngvel(
          { x: curW.x + add * wep.axis[0], y: curW.y + add * wep.axis[1], z: curW.z + add * wep.axis[2] },
          true,
        );
        part.spinOmega = Math.abs(nextProj);
      } else {
        wep.omega = Math.max(0, wep.omega - 8 * dt);
        part.spinOmega = wep.omega;
      }
    }

    // saws: damage bonus when spinning fast; spin with same path as weapons via parts map
    for (const p of rt.parts.values()) {
      if (p.def.weapon?.kind !== "saw" || p.destroyed) continue;
      const target = (p.def.weapon.spinupRpm * 2 * Math.PI) / 60;
      const loadState = net?.loads.get(p.partId);
      const powered = loadState?.powered ?? false;
      const spin = inp.fire && powered ? 1 : 0;
      p.spinOmega += (spin ? target : 0) > p.spinOmega ? dt * 10 : -dt * 10;
      p.spinOmega = Math.max(0, Math.min(p.spinOmega, target));
    }

    // lifters
    for (const lifter of rt.lifters) {
      lifter.cooldown = Math.max(0, lifter.cooldown - dt);
      if (inp.lift && lifter.cooldown === 0 && functional.has(lifter.partId)) {
        const part = rt.parts.get(lifter.partId)!;
        if (!part.destroyed && (net?.loads.get(lifter.partId)?.powered ?? false)) {
          lifter.cooldown = lifter.def.lifter!.recharge;
          // burst impulse upward + slightly forward on the whole robot
          for (const p of rt.parts.values()) {
            if (p.destroyed) continue;
            p.body.applyImpulse({ x: 0, y: (lifter.def.lifter!.impulse * 0.35) / Math.max(rt.totalMass(), 1) * p.def.mass * 4, z: 0 }, true);
          }
        }
      }
    }
  }

  private applyDamage(impulses: Map<PhysicsHandle, number>) {
    void impulses;
    for (const { a, b, force } of this.pw.contactPairs()) {
      if (force < DAMAGE_MIN_FORCE) continue;
      const pa = this.findByHandle(a);
      const pb = this.findByHandle(b);
      if (!pa || !pb) continue;

      if (pa.rt === pb.rt) {
        // same assembly: jointed neighbors (welds + wheel mounts) must never grind
        // each other down — solver contact forces at joint seams are spurious.
        if (this.jointedPair(pa.rt, pa.partId, pb.partId)) continue;
        // detached debris hitting its former body still damages
        this.damagePart(pa.rt, pa.partId, force * DAMAGE_SCALE, null);
        this.damagePart(pb.rt, pb.partId, force * DAMAGE_SCALE, null);
        continue;
      }

      // cross-robot contact: weapon boost replaces base damage when a fast weapon is involved
      const wepSide = this.fastWeaponIn(pa, pb);
      if (wepSide) {
        const { rt: wrt, partId: wpid, def: wdef } = wepSide;
        const victim = wrt === pa.rt ? pb : pa;
        const spinFrac = (wrt.parts.get(wpid)?.spinOmega ?? 0) / 60;
        const mult = wdef.weapon!.damageMult * Math.max(0.15, Math.min(spinFrac, 0.45));
        this.damagePart(victim.rt, victim.partId, force * DAMAGE_SCALE * mult, wdef.weapon!.kind);
        this.damagePart(wrt, wpid, force * DAMAGE_SCALE * 0.15, null); // recoil into own frame
      } else {
        this.damagePart(pa.rt, pa.partId, force * DAMAGE_SCALE, null);
        this.damagePart(pb.rt, pb.partId, force * DAMAGE_SCALE, null);
      }
      if (this.events.onBigHit && force > 8000) this.events.onBigHit(pa.rt.side, pa.partId, force);
    }
  }

  private jointedPair(rt: RobotRuntime, a: string, b: string): boolean {
    if (rt.welds.has(`w_${a}_${b}`) || rt.welds.has(`w_${b}_${a}`)) return true;
    for (const w of rt.wheels) {
      if ((w.wheelPartId === a && w.motorPartId === b) || (w.wheelPartId === b && w.motorPartId === a)) return true;
    }
    return false;
  }

  private fastWeaponIn(pa: { rt: RobotRuntime; partId: string }, pb: { rt: RobotRuntime; partId: string }): { rt: RobotRuntime; partId: string; def: PartDef } | null {
    for (const cand of [pa, pb]) {
      const part = cand.rt.parts.get(cand.partId);
      if (!part || part.destroyed || !part.def.weapon) continue;
      if (part.def.weapon.kind === "lifter") continue;
      if (part.spinOmega < SPINNER_MIN_HIT) continue;
      return { rt: cand.rt, partId: cand.partId, def: part.def };
    }
    return null;
  }

  private findByHandle(h: number): { rt: RobotRuntime; partId: string } | null {
    for (const rt of this.robots) {
      for (const p of rt.parts.values()) {
        if (p.destroyed) continue;
        if (handleHandle(p.body) === h) return { rt, partId: p.partId };
      }
    }
    return null;
  }

  private damagePart(rt: RobotRuntime, partId: string, dmg: number, weaponKind: string | null) {
    const p = rt.parts.get(partId);
    if (!p || p.destroyed || dmg <= 0) return;
    const armor = partArmorFactor(p.def, weaponKind);
    p.hp -= dmg / armor;
    // share damage with welds
    const welds = rt.welds;
    if (p.welds.length > 0) {
      const share = (dmg * WELD_DAMAGE_SHARE) / p.welds.length;
      for (const wid of [...p.welds]) {
        const w = welds.get(wid);
        if (!w) continue;
        w.hp -= share;
        if (w.hp <= 0) {
          this.pw.removeJoint(w.joint);
          welds.delete(wid);
          const pa = rt.parts.get(w.a);
          const pb = rt.parts.get(w.b);
          if (pa) pa.welds = pa.welds.filter((x) => x !== wid);
          if (pb) pb.welds = pb.welds.filter((x) => x !== wid);
          this.events.onWeldBroken?.(rt.side, w.a, w.b);
        }
      }
    }
    if (p.hp <= 0) {
      p.destroyed = true;
      this.destroyedCount[rt.side]++;
      // detach: remove remaining welds
      for (const wid of [...p.welds]) {
        const w = welds.get(wid);
        if (w) {
          this.pw.removeJoint(w.joint);
          welds.delete(wid);
          const pa = rt.parts.get(w.a);
          const pb = rt.parts.get(w.b);
          if (pa) pa.welds = pa.welds.filter((x) => x !== wid);
          if (pb) pb.welds = pb.welds.filter((x) => x !== wid);
        }
      }
      p.welds = [];
      this.events.onPartDestroyed?.(rt.side, partId, p.def.id);
    }
  }

  private applyHeat(dt: number) {
    for (const rt of this.robots) {
      const net = this.powerNets[rt.side];
      let coolingBonus = 0;
      for (const p of rt.parts.values()) {
        if (p.destroyed) continue;
        if (p.def.cooling) {
          const powered = !rt.bp.wires.length || (net?.loads.get(p.partId)?.powered ?? true);
          coolingBonus += p.def.cooling.rate * (p.def.cooling.drawW > 0 && !powered ? 0.3 : 1);
        }
      }
      const exposed = this.enclosureFactor(rt);
      for (const p of rt.parts.values()) {
        if (p.destroyed) continue;
        const load = net?.loads.get(p.partId);
        let gen = 0;
        if (load?.deliveredW) {
          const frac = Math.min(load.deliveredW / Math.max(load.requestedW, 1), 1);
          const heatCoef = rt.batteries.get(p.partId)?.heatCoef ?? 1;
          gen = frac * HEAT_GEN_FULL_LOAD * heatCoef * (p.def.motor ? 1 : p.def.weapon ? 1.2 : p.def.controller ? 0.8 : 0.5);
        }
        const cool = HEAT_PASSIVE_COOL * (1 + coolingBonus) * exposed;
        p.temp += (gen - cool * (p.temp - AMBIENT)) * dt;
        if (p.temp > OVERHEAT_DAMAGE) this.damagePart(rt, p.partId, (p.temp - OVERHEAT_DAMAGE) * 0.15 * dt, null);
        p.temp = Math.max(AMBIENT, Math.min(p.temp, 400));
      }
    }
  }

  /** Sealed boxes heat up: fewer exterior faces per part => less airflow. */
  private enclosureFactor(rt: RobotRuntime): number {
    const alive = rt.aliveParts();
    let exposedFaces = 0;
    let totalParts = 0;
    for (const w of rt.bp.wires) void w;
    for (const p of rt.parts.values()) {
      if (p.destroyed) continue;
      totalParts++;
      let neighbors = 0;
      for (const wid of p.welds) {
        const w = rt.welds.get(wid);
        if (w && alive.has(w.a) && alive.has(w.b)) neighbors++;
      }
      exposedFaces += Math.max(0, 6 - neighbors * 2);
    }
    if (totalParts === 0) return 1;
    return 0.55 + 0.45 * (exposedFaces / (totalParts * 6));
  }

  private evaluateDefeat() {
    if (this.outcome) return; // sticky: first verdict stands
    const res = [
      evaluateDefeat(this.robots[0], (rt) => this.functionalParts(rt)),
      evaluateDefeat(this.robots[1], (rt) => this.functionalParts(rt)),
    ];
    this.robots[0].lastResult = res[0]!;
    this.robots[1].lastResult = res[1]!;

    const t0 = res[0]!.destroyed ? this.robots[0].destroyedTimer + 0.5 : 0;
    const t1 = res[1]!.destroyed ? this.robots[1].destroyedTimer + 0.5 : 0;
    this.robots[0].destroyedTimer = t0;
    this.robots[1].destroyedTimer = t1;

    if (t0 >= 3 || t1 >= 3) {
      const both = t0 >= 3 && t1 >= 3;
      this.robots[0].isDestroyed = t0 >= 3;
      this.robots[1].isDestroyed = t1 >= 3;
      this.frozen = true;
      this.outcome = both
        ? { kind: "ko", winner: null, reason: "double-knockout" }
        : t0 >= 3
          ? { kind: "ko", winner: 1, reason: "blue robot destroyed" }
          : { kind: "ko", winner: 0, reason: "red robot destroyed" };
    }
  }

  // ---- netcode support ----

  /** Compact quantized snapshot of both robots' dynamic state. */
  snapshot(): number[] {
    const out: number[] = [this.tick];
    for (const rt of this.robots) {
      for (const p of rt.parts.values()) {
        if (p.destroyed) {
          out.push(-1);
          continue;
        }
        const t = p.body.translation();
        const r = p.body.rotation();
        const v = p.body.linvel();
        const w = p.body.angvel();
        out.push(
          q(t.x), q(t.y), q(t.z),
          q(r.x), q(r.y), q(r.z), q(r.w),
          q(v.x), q(v.y), q(v.z),
          q(w.x), q(w.y), q(w.z),
        );
      }
    }
    return out;
  }

  applySnapshot(snap: number[], blend = 0) {
    if (snap[0] === undefined) return;
    this.tick = Math.max(this.tick, snap[0]);
    let i = 1;
    for (const rt of this.robots) {
      for (const p of rt.parts.values()) {
        const flag = snap[i];
        if (flag === -1) {
          i += 1;
          continue;
        }
        const vals = snap.slice(i, i + 13);
        i += 13;
        if (vals.length < 13) return;
        const t = p.body.translation();
        const setT = {
          x: blend ? t.x + (vals[0]! - t.x) * blend : vals[0]!,
          y: blend ? t.y + (vals[1]! - t.y) * blend : vals[1]!,
          z: blend ? t.z + (vals[2]! - t.z) * blend : vals[2]!,
        };
        p.body.setTranslation(setT, true);
        const r = p.body.rotation();
        p.body.setRotation(
          {
            x: r.x + (vals[3]! - r.x) * blend,
            y: r.y + (vals[4]! - r.y) * blend,
            z: r.z + (vals[5]! - r.z) * blend,
            w: r.w + (vals[6]! - r.w) * blend,
          },
          true,
        );
        p.body.setLinvel(
          {
            x: blend ? p.body.linvel().x + (vals[7]! - p.body.linvel().x) * blend : vals[7]!,
            y: blend ? p.body.linvel().y + (vals[8]! - p.body.linvel().y) * blend : vals[8]!,
            z: blend ? p.body.linvel().z + (vals[9]! - p.body.linvel().z) * blend : vals[9]!,
          },
          true,
        );
        p.body.setAngvel(
          {
            x: blend ? p.body.angvel().x + (vals[10]! - p.body.angvel().x) * blend : vals[10]!,
            y: blend ? p.body.angvel().y + (vals[11]! - p.body.angvel().y) * blend : vals[11]!,
            z: blend ? p.body.angvel().z + (vals[12]! - p.body.angvel().z) * blend : vals[12]!,
          },
          true,
        );
      }
    }
  }

  /** Simulation checksum at this tick (quantized transforms). */
  checksum(): string {
    let h = 0x811c9dc5;
    const mix = (n: number) => {
      const v = Math.round(n * 8) | 0;
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
    };
    for (const rt of this.robots) {
      for (const p of rt.parts.values()) {
        if (p.destroyed) continue;
        const t = p.body.translation();
        mix(t.x);
        mix(t.y);
        mix(t.z);
      }
    }
    return (h >>> 0).toString(16);
  }

  debugInfo(): SimDebugInfo {
    return {
      tick: this.tick,
      robots: this.robots.map((rt) => {
        let hottest: { name: string; temp: number } | null = null;
        let aliveCount = 0;
        for (const p of rt.parts.values()) {
          if (p.destroyed) continue;
          aliveCount++;
          if (!hottest || p.temp > hottest.temp) hottest = { name: p.def.name, temp: p.temp };
        }
        const net = this.powerNets[rt.side];
        return {
          mass: rt.totalMass(),
          charge: rt.charge,
          demandW: net?.totalDemandW ?? 0,
          deliveredW: net?.totalDeliveredW ?? 0,
          hottest,
          mobility: rt.lastResult.mobility,
          offense: rt.lastResult.offense,
          control: rt.lastResult.control,
          destroyedTimer: rt.destroyedTimer,
          partsAlive: aliveCount,
          partsTotal: rt.parts.size,
        };
      }),
    };
  }

  destroy() {
    this.pw.destroy();
  }
}

const SPINNER_MIN_HIT = 8;

function q(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function handleHandle(b: PhysicsHandle): number {
  return (b as unknown as { handle: number }).handle;
}

function partArmorFactor(def: { id: string }, weaponKind: string | null): number {
  let f = 1;
  if (def.id === "armor_hardened") f = 1.7;
  else if (def.id === "armor_steel") f = 1.35;
  else if (def.id === "armor_alum") f = 0.9;
  else if (def.id === "armor_wedge") f = 1.4;
  if (weaponKind === "saw") f *= 1.6; // saws ignore armor partially
  return f;
}

function totalCapacityKJ(rt: RobotRuntime): number {
  let s = 0;
  for (const [pid, b] of rt.batteries) {
    const part = rt.parts.get(pid);
    if (!part || part.destroyed) continue;
    s += b.energyKJ;
  }
  return Math.max(s, 1);
}

void PART_DEFS;
void newRobotInput;
