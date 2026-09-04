// SCRAP & STEEL — game/sim.ts
// Match/test simulation. Two (or one) robots in a planck world. Every tick:
// inputs -> logic -> power -> actuation -> physics -> damage -> heat -> defeat.
// Same rules for players and bots: bots set virtual keys and drive the exact
// same logic circuits.

import planck from "planck-js";
import { computeAdjacency, type Blueprint } from "./blueprint";
import { part, PART_EXTRA, CELL } from "./parts";
import { buildRobotWorld, makeProjectile, destroyPartBody, type RobotPhysics } from "./physics";
import { buildArenaWorld, type ArenaDef } from "./arena";
import { createNet, solveNet, stepFuses, type PowerNet } from "./electric";
import { createLogicRuntime, evalLogic, type LogicRuntime, type LogicContext } from "./logic";

export const TICK = 1 / 60;

export interface RobotInputs {
  forward: number;
  back: number;
  fire: number;
  aux: number;
  turret: number;
}

export interface RobotSide {
  index: number;
  bp: Blueprint;
  phys: RobotPhysics;
  net: PowerNet;
  logic: LogicRuntime;
  input: RobotInputs;
  alive: boolean;
  destroyedTimer: number;
  isOut: boolean;
  defeated: boolean;
  partsLost: number;
  damageDealt: number;
  heat: Map<string, number>; // partId -> 0..200 C
  ammo: Map<string, number>;
  weaponCooldown: Map<string, number>;
  motorTemps: Map<string, number>;
  lastResult: { mobility: boolean; offense: boolean; control: boolean };
  capBufferKJ: number;
  railCharge: number;
  adjacency: Map<string, string[]> | null;
}

export type MatchOutcome = { kind: "ko"; winner: number | null; reason: string } | { kind: "timeout"; winner: null; reason: "time-limit" } | null;

export interface SimEvents {
  onHit?: (robot: number, partId: string, force: number) => void;
  onPartDestroyed?: (robot: number, partId: string) => void;
  onShot?: (robot: number, x: number, y: number) => void;
  onExplosion?: (x: number, y: number, big: boolean) => void;
}

export interface SimOptions {
  bpA: Blueprint;
  bpB: Blueprint | null;
  arena: ArenaDef;
  seed: number;
  bots?: { a?: BotDriver; b?: BotDriver };
}

export interface BotDriver {
  update: (self: RobotView, enemy: RobotView | null, inputs: RobotInputs, dt: number) => void;
  difficulty: number; // 0..1
}

export interface RobotView {
  x: number;
  y: number;
  angle: number;
  facing: number; // +1 right, -1 left
  alive: boolean;
  destroyed: boolean;
}

const MIN_DAMAGE_IMPULSE = 60;
const KO_CONFIRM = 3.0;

let rngState = 1;
function srand(seed: number) {
  rngState = seed >>> 0 || 1;
}
// seeded RNG used for deterministic match variations (muzzle jitter etc.)
function rnd(): number {
  rngState = (rngState * 16807) % 2147483647;
  return rngState / 2147483647;
}
void rnd;

export class Simulation {
  lastMotorPowers = new Map<string, number>();
  world: planck.World;
  arena: ArenaDef;
  robots: [RobotSide, RobotSide | null];
  tick = 0;
  outcome: MatchOutcome = null;
  frozen = false;
  events: SimEvents = {};
  projectiles: { body: planck.Body; life: number; dmg: number; robot: number }[] = [];
  partToRobot = new Map<string, number>();
  logicCtx: LogicContext;

  constructor(opts: SimOptions) {
    srand(opts.seed);
    this.arena = opts.arena;
    this.world = new planck.World({ gravity: planck.Vec2(0, -9.8) });
    buildArenaWorld(this.world, opts.arena);

    const mk = (bp: Blueprint, idx: number, ox: number): RobotSide => {
      const phys = buildRobotWorld(this.world, bp, { ox, robotBits: 0x0002 | (idx === 0 ? 0x0020 : 0x0040), groundAlign: true });
      const net = createNet(bp);
      const side: RobotSide = {
        index: idx, bp, phys, net,
        logic: createLogicRuntime(),
        input: { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 },
        alive: true, destroyedTimer: 0, isOut: false, defeated: false,
        partsLost: 0, damageDealt: 0,
        heat: new Map(), ammo: new Map(), weaponCooldown: new Map(), motorTemps: new Map(),
        lastResult: { mobility: false, offense: false, control: false },
        capBufferKJ: 0, railCharge: 0, adjacency: null,
      };
      for (const p of bp.parts) {
        this.partToRobot.set(p.id, idx);
        const d = part(p.def);
        if (d.weapon?.ammoCap) side.ammo.set(p.id, d.weapon.ammoCap);
      }
      return side;
    };

    this.robots = [mk(opts.bpA, 0, opts.arena.width / 2 - 9), null];
    if (opts.bpB) {
      this.robots[1] = mk(opts.bpB, 1, opts.arena.width / 2 + 5);
    }

    // contact damage
    this.world.on("post-solve", (contact: planck.Contact, impulse: planck.ContactImpulse) => {
      const ua = contact.getFixtureA().getUserData() as string | null | undefined;
      const ub = contact.getFixtureB().getUserData() as string | null | undefined;
      if (!ua || !ub) return;
      const ni = (impulse.normalImpulses?.[0] ?? 0);
      this.applyContactDamage(ua, ub, ni);
    });

    this.logicCtx = {
      keys: { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 },
      readSensor: () => 0,
      motorPowers: new Map(),
      servoTargets: new Map(),
      weaponFire: new Map(),
      brake: 0,
    };
    // sensor binding
    this.logicCtx.readSensor = (partId: string) => this.readSensor(partId);
  }

  // ---------------- helpers ----------------

  sideOfPart(partId: string): RobotSide | null {
    const idx = this.partToRobot.get(partId);
    if (idx === undefined) return null;
    return this.robots[idx] ?? null;
  }

  enemyOf(side: RobotSide): RobotSide | null {
    const other = this.robots[1 - side.index];
    return other && !other.defeated ? other : null;
  }

  rootPos(side: RobotSide): { x: number; y: number; angle: number } {
    const root = side.phys.rootBody;
    if (!root) return { x: 0, y: 0, angle: 0 };
    const p = root.getPosition();
    return { x: p.x, y: p.y, angle: root.getAngle() };
  }

  view(side: RobotSide): RobotView {
    const pos = this.rootPos(side);
    return {
      x: pos.x, y: pos.y, angle: pos.angle,
      facing: Math.cos(pos.angle) >= 0 ? 1 : -1,
      alive: !side.defeated,
      destroyed: side.defeated,
    };
  }

  readSensor(partId: string): number {
    const side = this.sideOfPart(partId);
    if (!side) return 0;
    const p = side.bp.parts.find((q) => q.id === partId);
    if (!p) return 0;
    const d = part(p.def);
    if (!d.sensor) return 0;
    if (!side.net.loads.get(partId)?.powered) return 0;
    switch (d.sensor.kind) {
      case "distance": {
        const body = side.phys.bodies.get(partId)?.body;
        if (!body) return d.sensor.range ?? 8;
        const pos = body.getPosition();
        const dir = Math.cos(this.rootPos(side).angle) >= 0 ? 1 : -1;
        const range = d.sensor.range ?? 8;
        let best = range;
        this.world.rayCast(pos, planck.Vec2(pos.x + dir * range, pos.y), (fixture, point) => {
          const ud = fixture.getUserData() as string;
          if (ud === partId) return -1; // ignore self
          const dist = Math.hypot(point.x - pos.x, point.y - pos.y);
          if (dist > 0.15 && dist < best) best = dist;
          return range; // continue to nearest
        });
        return best;
      }
      case "gyro": {
        const ang = this.rootPos(side).angle;
        return (Math.abs(ang) > Math.PI / 2 ? Math.sign(ang) * (Math.PI - Math.abs(ang)) * -1 : ang) * (180 / Math.PI);
      }
      case "battery": {
        const frac = side.net.capacityKJ > 0 ? side.net.storedKJ / side.net.capacityKJ : 0;
        return Math.round(frac * 100);
      }
      case "voltage": return side.net.busVoltage;
      case "current": return side.net.busCurrent;
      case "temp": {
        let hot = 20;
        for (const t of side.heat.values()) hot = Math.max(hot, t);
        return Math.round(hot);
      }
      case "speed": {
        const root = side.phys.rootBody;
        if (!root) return 0;
        const v = root.getLinearVelocity();
        return Math.round(Math.hypot(v.x, v.y) * 3.6 * 10) / 10;
      }
      case "impact": {
        let g = 0;
        for (const [pid2] of side.phys.bodies) {
          const imp = side.phys.impactAcc.get(pid2) ?? 0;
          g = Math.max(g, imp);
        }
        return Math.round(g / 40); // rough g estimate
      }
      case "proximity": {
        const pos = side.phys.bodies.get(partId)?.body.getPosition();
        if (!pos) return 0;
        const enemy = this.enemyOf(side);
        if (!enemy) return 0;
        const epos = this.rootPos(enemy);
        return Math.hypot(epos.x - pos.x, epos.y - pos.y) < (d.sensor.range ?? 3) ? 1 : 0;
      }
      case "radar": {
        // composite output: bearing deg in the integer part, range in meters —
        // exposed as two nodes by the sim: use sensor_value with part id + suffix.
        // handled in readSensorExtended
        return 0;
      }
      default: return 0;
    }
  }

  /** radar exposes bearing & range via virtual sensor ids "<partId>#bearing" / "#range" */
  readSensorExtended(key: string): number {
    if (key.endsWith("#bearing") || key.endsWith("#range")) {
      const partId = key.split("#")[0]!;
      const side = this.sideOfPart(partId);
      if (!side) return 0;
      if (!side.net.loads.get(partId)?.powered) return 0;
      const enemy = this.enemyOf(side);
      if (!enemy) return 0;
      const body = side.phys.bodies.get(partId)?.body;
      const epos = this.rootPos(enemy);
      const pos = body?.getPosition() ?? planck.Vec2(epos.x, epos.y);
      const dx = epos.x - pos.x;
      const dy = epos.y - pos.y;
      if (key.endsWith("#range")) return Math.round(Math.hypot(dx, dy) * 10) / 10;
      const worldAng = (Math.atan2(dy, dx) * 180) / Math.PI;
      const facingDeg = (this.rootPos(side).angle * 180) / Math.PI;
      let rel = worldAng - facingDeg;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      return Math.round(rel);
    }
    return this.readSensor(key);
  }

  // ---------------- damage ----------------

  applyContactDamage(userA: string, userB: string, impulse: number) {
    if (impulse < MIN_DAMAGE_IMPULSE) return;
    if (this.tick < 45) return; // spawn grace: settling contact never damages
    const isProjA = userA.startsWith("proj:");
    const isProjB = userB.startsWith("proj:");
    if (isProjA || isProjB) {
      const projStr = isProjA ? userA : userB;
      const targetPart = isProjA ? userB : userA;
      const [, ownerStr, dmgStr] = projStr.split(":");
      const dmg = parseFloat(dmgStr ?? "0");
      const owner = parseInt(ownerStr ?? "-1");
      const targetSide = this.sideOfPart(targetPart);
      if (targetSide && targetSide.index !== owner) {
        this.damagePart(targetSide, targetPart, dmg);
        const enemy = this.robots[owner];
        if (enemy) enemy.damageDealt += dmg;
        const pb = targetSide.phys.bodies.get(targetPart)?.body.getPosition();
        if (pb) this.events.onHit?.(targetSide.index, targetPart, dmg);
        this.events.onExplosion?.(pb?.x ?? 0, pb?.y ?? 0, false);
      }
      return;
    }
    // robot-robot or robot-terrain impact damage
    const sideA = this.sideOfPart(userA);
    const sideB = this.sideOfPart(userB);
    const dmg = Math.min(120, (impulse - MIN_DAMAGE_IMPULSE) * 0.06); // capped: one ram never one-shots
    if (sideA && sideB && sideA !== sideB) {
      // robot vs robot: both take damage, scaled by armor
      this.damagePart(sideA, userA, dmg);
      this.damagePart(sideB, userB, dmg);
      sideA.damageDealt += dmg;
      sideB.damageDealt += dmg;
      this.events.onHit?.(sideA.index, userA, dmg);
    } else if (sideA && !sideB) {
      this.damagePart(sideA, userA, dmg * 0.5);
    } else if (sideB && !sideA) {
      this.damagePart(sideB, userB, dmg * 0.5);
    }
  }

  damagePart(side: RobotSide, partId: string, dmg: number) {
    const pb = side.phys.bodies.get(partId);
    if (!pb || pb.destroyed) return;
    const armor = pb.def.armor ?? 1;
    const ex = PART_EXTRA[pb.def.id];
    let final = dmg * armor;
    if (ex?.reactive) final *= 0.25; // reactive eats most of a hit
    if (ex?.heatProof && pb.temp > 60) final *= 0.6;
    pb.hp -= final;
    side.phys.impactAcc.set(partId, final);
    if (pb.hp <= 0 && !pb.destroyed) {
      pb.destroyed = true; // mark first: splash recursion must see it as gone
      side.partsLost++;
      // ammo explosion
      if (ex?.ammo) {
        const pos = pb.body.getPosition();
        this.events.onExplosion?.(pos.x, pos.y, true);
        // splash damage to nearby parts
        for (const [pid, other] of side.phys.bodies) {
          if (other.destroyed) continue;
          const op = other.body.getPosition();
          const dist = Math.hypot(op.x - pos.x, op.y - pos.y);
          if (dist < 2.5 && pid !== partId) this.damagePart(side, pid, 90 * (1 - dist / 2.5));
        }
        const enemy = this.enemyOf(side);
        if (enemy) {
          const epos = this.rootPos(enemy);
          const dist = Math.hypot(epos.x - pos.x, epos.y - pos.y);
          if (dist < 3) this.damagePart(enemy, enemy.bp.parts[0]!.id, 60);
        }
      }
      const pos = pb.body.getPosition();
      destroyPartBody(side.phys, partId);
      this.events.onPartDestroyed?.(side.index, partId);
      this.events.onExplosion?.(pos.x, pos.y, false);
    }
  }

  private aliveSet(rt: RobotSide): Set<string> {
    const s = new Set<string>();
    for (const [id, pb] of rt.phys.bodies) if (!pb.destroyed) s.add(id);
    return s;
  }

  /** Is part `a` still weld-connected to part `b` through surviving parts?
   *  (2D welds are unbreakable — connections persist while both end parts live.) */
  weldConnected(rt: RobotSide, a: string, b: string): boolean {
    if (a === b) return true;
    const adj = rt.adjacency ?? (rt.adjacency = new Map<string, string[]>(
      computeAdjacency(rt.bp).flatMap((w) => [[w.a, w.b] as const, [w.b, w.a] as const])
        .reduce((m, [from, to]) => {
          const list = m.get(from) ?? [];
          list.push(to);
          m.set(from, list);
          return m;
        }, new Map<string, string[]>()),
    ));
    const alive = this.aliveSet(rt);
    if (!alive.has(a) || !alive.has(b)) return false;
    const seen = new Set<string>([a]);
    const q: string[] = [a];
    while (q.length) {
      const cur = q.shift()!;
      for (const n of adj.get(cur) ?? []) {
        if (!alive.has(n)) continue;
        if (n === b) return true;
        if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
    }
    return false;
  }

  // ---------------- main tick ----------------

  step(dt: number, botA?: BotDriver, botB?: BotDriver) {
    if (this.frozen) return;
    this.tick++;

    // bot brains set virtual keys
    for (const [side, driver] of [[this.robots[0], botA], [this.robots[1], botB]] as [RobotSide | null, BotDriver | undefined][]) {
      if (!side || !driver) continue;
      if (side.defeated) continue;
      const enemy = this.enemyOf(side);
      const view = this.view(side);
      const eview = enemy ? this.view(enemy) : null;
      side.input.forward = 0; side.input.back = 0; side.input.fire = 0; side.input.aux = 0; side.input.turret = 0;
      driver.update(view, eview, side.input, dt);
    }

    for (const side of this.robots) {
      if (!side || side.defeated) continue;
      this.stepRobot(side, dt);
    }

    // physics
    this.world.step(dt);

    // projectiles lifetime
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i]!;
      pr.life -= dt;
      if (pr.life <= 0) {
        this.world.destroyBody(pr.body);
        this.projectiles.splice(i, 1);
      } else {
        const p = pr.body.getPosition();
        if (p.y < -3 || p.x < -2 || p.x > this.arena.width + 2) {
          this.world.destroyBody(pr.body);
          this.projectiles.splice(i, 1);
        }
      }
    }

    // defeat evaluation at 2 Hz
    if (this.tick % 30 === 0) this.evaluateDefeat();
  }

  private stepRobot(side: RobotSide, dt: number) {
    // alive part set
    const alive = new Set<string>();
    for (const [id, pb] of side.phys.bodies) if (!pb.destroyed) alive.add(id);

    // ---------- logic ----------
    this.logicCtx.keys = {
      forward: side.input.forward, back: side.input.back,
      fire: side.input.fire, aux: side.input.aux, turret: side.input.turret,
    };
    // sensor readings routed through extended reader (radar #bearing/#range)
    const rawRead = this.logicCtx.readSensor;
    this.logicCtx.readSensor = (partId: string) => this.readSensorExtended(partId);
    evalLogic(side.bp.logic, side.logic, this.logicCtx, dt);
    this.logicCtx.readSensor = rawRead;
    this.lastMotorPowers = new Map(this.logicCtx.motorPowers);

    // ---------- power demands ----------
    const demands = new Map<string, number>();
    for (const p of side.bp.parts) {
      if (!alive.has(p.id)) continue;
      const d = part(p.def);
      let watts = d.idleWatts ?? 0;
      if (d.motor) {
        const commanded = this.logicCtx.motorPowers.get(p.id) ?? 0;
        if (commanded !== 0) watts = d.motor.watts * Math.abs(commanded);
      }
      if (d.weapon && !PART_EXTRA[p.def]?.barrel) {
        const firing = this.logicCtx.weaponFire.get(p.id) === 1;
        const spinning = d.weapon.kind === "rotary" ? (side.motorTemps.get(p.id) ?? 0) > 0.05 : false;
        if (firing || spinning) watts = Math.max(watts, d.weapon.watts);
      }
      if (d.piston) {
        const target = this.logicCtx.servoTargets.get(p.id);
        if (target !== undefined) watts = Math.max(watts, 80);
      }
      if (d.track) {
        const cmd = this.logicCtx.motorPowers.get(p.id) ?? 0;
        if (Math.abs(cmd) > 0.02) demands.set(p.id, Math.round(Math.abs(cmd) * 1500));
      }
      if (d.weapon?.kind === "spinner") {
        const wantsSpin = (this.logicCtx.weaponFire.get(p.id) === 1) || (this.logicCtx.motorPowers.get(p.id) ?? 0) !== 0;
        if (wantsSpin) demands.set(p.id, Math.max(demands.get(p.id) ?? 0, 1200));
      }
      if (watts > 0) demands.set(p.id, watts);
    }
    const regulators = side.bp.parts.filter((p) => alive.has(p.id) && part(p.def).id === "regulator").length;
    solveNet(side.bp, side.net, demands, alive, dt, regulators);
    stepFuses(side.bp, side.net, dt);

    // ---------- actuation ----------
    const powered = (id: string) => side.net.loads.get(id)?.powered ?? false;
    const sagFactor = side.net.busVoltage / 48;

    for (const p of side.bp.parts) {
      if (!alive.has(p.id)) continue;
      const d = part(p.def);
      const pb = side.phys.bodies.get(p.id)!;

      // drive motors: torque from logic, plus keyboard fallbacks handled by logic
      if (d.motor) {
        const cmd = this.logicCtx.motorPowers.get(p.id) ?? 0;
        const temp = side.motorTemps.get(p.id) ?? 0;
        const thermal = temp > 120 ? 0 : temp > 90 ? 0.5 : 1;
        const poweredOk = powered(p.id);
        const scale = poweredOk ? sagFactor * thermal : 0;
        const drivesAnything = side.phys.wheels.some((w) => w.motorPartId === p.id) || side.phys.tracks.some((t) => t.motorPartId === p.id);
        // wheel joints
        for (const wheel of side.phys.wheels) {
          if (wheel.motorPartId !== p.id) continue;
          const j = wheel.joint;
          if (!this.weldConnected(side, wheel.partId, wheel.motorPartId)) { j.enableMotor(false); continue; }
          if (this.logicCtx.brake === 1 && cmd === 0) {
            j.setMotorSpeed(0);
            j.setMaxMotorTorque(d.motor.torque * 2);
            j.enableMotor(true);
            continue;
          }
          const maxOmega = (d.motor.rpm * 2 * Math.PI) / 60;
          const targetOmega = -cmd * maxOmega; // planck +z CCW: negative drives the robot toward +x
          const current = j.getJointSpeed();
          const err = targetOmega - current;
          const torque = Math.max(-d.motor.torque, Math.min(d.motor.torque, err * d.motor.torque * 0.3)) * scale;
          j.setMaxMotorTorque(Math.abs(torque) + 0.5);
          j.setMotorSpeed(targetOmega);
          j.enableMotor(Math.abs(cmd) > 0.01);
        }
        // track units: direct linear force along the chassis facing
        for (const track of side.phys.tracks) {
          if (track.motorPartId !== p.id) continue;
          if (Math.abs(cmd) < 0.02 || scale <= 0) continue;
          const facing = Math.cos(this.rootPos(side).angle) >= 0 ? 1 : -1;
          const force = cmd * d.motor.torque * 3.2 * scale * (d.motor.watts / 900);
          track.body.applyForceToCenter(planck.Vec2(facing * force, 0), true);
        }
        void drivesAnything;
        // heat from use
        const heatGen = d.motor.heat * Math.abs(cmd) * 18 * dt;
        side.motorTemps.set(p.id, Math.min(180, temp + heatGen - (temp - 20) * 0.12 * dt * (1 + this.coolingFactor(side))));
        side.heat.set(p.id, side.motorTemps.get(p.id) ?? 20);
        if ((side.motorTemps.get(p.id) ?? 0) > 150) this.damagePart(side, p.id, 6 * dt);
      }

      // spinners: need a powered motor somewhere on the robot + fire command
      if (d.weapon?.kind === "spinner") {
        const motor = side.phys.motors.get(p.id);
        const wantsSpin = (this.logicCtx.weaponFire.get(p.id) === 1) || (this.logicCtx.motorPowers.get(p.id) ?? 0) !== 0;
        if (motor && motor.kind === "spinner") {
          const j = motor.joint as planck.RevoluteJoint;
          const motorOk = [...side.phys.bodies.values()].some((pb2) => !pb2.destroyed && !!pb2.def.motor && powered(pb2.partId));
          const poweredOk = powered(p.id) || (motorOk && d.weapon.watts === 0);
          const thermal = (side.heat.get(p.id) ?? 20) > 130 ? 0.4 : 1;
          const target = wantsSpin && poweredOk ? 26 * thermal * sagFactor : 0;
          const speed = j.getJointSpeed();
          const dir = Math.sign(speed) || 1;
          j.enableMotor(true);
          j.setMaxMotorTorque(90);
          j.setMotorSpeed(dir * Math.max(Math.abs(speed), target));
          pb.spinRate = Math.abs(speed);
          // heat
          if (wantsSpin) side.heat.set(p.id, Math.min(160, (side.heat.get(p.id) ?? 20) + d.weapon.heat * 8 * dt));
        }
        // contact damage handled via post-solve with spinRate multiplier:
        // implemented in damagePart? — spinner bonus applied in applyContactDamage
      }

      // track units: self-motorised drive modules commanded directly by logic
      if (d.track) {
        const cmd = this.logicCtx.motorPowers.get(p.id) ?? 0;
        const poweredOk = powered(p.id);
        if (poweredOk && Math.abs(cmd) > 0.02) {
          const facing = Math.cos(this.rootPos(side).angle) >= 0 ? 1 : -1;
          const force = cmd * 9000 * sagFactor;
          pb.body.applyForceToCenter(planck.Vec2(facing * force, 0), true);
          side.heat.set(p.id, Math.min(140, (side.heat.get(p.id) ?? 20) + 6 * dt));
        }
      }

      // servos and turret bearings: position-controlled via logic, or key-driven
      if (d.servo || PART_EXTRA[p.def]?.turret) {
        const isTurret = !!PART_EXTRA[p.def]?.turret;
        const motor = side.phys.motors.get(p.id + (isTurret ? ":turret" : ""));
        if (motor && motor.kind === "servo") {
          const j = motor.joint as planck.RevoluteJoint;
          const maxSpeed = (d.servo?.speed ?? 3) * 2;
          const logicTarget = this.logicCtx.servoTargets.get(p.id);
          let targetDeg: number;
          if (logicTarget !== undefined) {
            targetDeg = logicTarget;
          } else if (isTurret) {
            // fallback: direct turret-key control
            const cur = (j.getJointAngle() * 180) / Math.PI;
            targetDeg = Math.max(-180, Math.min(180, cur + this.logicCtx.keys.turret * 120 * dt));
          } else {
            targetDeg = 0;
          }
          const target = (targetDeg * Math.PI) / 180;
          const err = target - j.getJointAngle();
          j.setMotorSpeed(Math.max(-maxSpeed, Math.min(maxSpeed, err * 4)));
          j.setMaxMotorTorque(d.servo?.torque ?? 60);
          j.enableMotor(true);
          void powered;
        }
      }

      // pistons
      if (d.piston) {
        const motor = side.phys.motors.get(p.id);
        if (motor && motor.kind === "piston") {
          const j = motor.joint as planck.PrismaticJoint;
          const t = this.logicCtx.servoTargets.get(p.id);
          if (t !== undefined && powered(p.id)) {
            const ext = Math.max(0, Math.min(1, t)); // 0..1 extension
            const target = ext * d.piston.range;
            const cur = j.getJointTranslation();
            j.setMotorSpeed(Math.sign(target - cur) * d.piston.speed);
            j.setMaxMotorForce(d.piston.force * (Math.abs(target - cur) > 0.01 ? 1 : 0.2));
            j.enableMotor(true);
          } else {
            j.enableMotor(false);
          }
        }
      }
    }

    // ---------- weapons ----------
    for (const p of side.bp.parts) {
      if (!alive.has(p.id)) continue;
      const d = part(p.def);
      const w = d.weapon;
      if (!w || PART_EXTRA[p.def]?.barrel) continue;
      if (w.kind === "spinner") continue;
      const fire = this.logicCtx.weaponFire.get(p.id) === 1;
      const cd = side.weaponCooldown.get(p.id) ?? 0;
      side.weaponCooldown.set(p.id, Math.max(0, cd - dt));
      if (!fire || !powered(p.id) || cd > 0) {
        // rotary spin-down marker
        continue;
      }
      // ammo check
      const ammoPart = side.bp.parts.find((q) => alive.has(q.id) && part(q.def).weapon?.ammoCap && side.net.loads.get(q.id)?.powered !== false);
      let ammoOk = w.kind === "rail" || w.kind === "arc"; // energy weapons don't need ammo
      if (w.kind === "cannon" || w.kind === "rotary" || w.kind === "missile") {
        if (ammoPart) {
          const count = side.ammo.get(ammoPart.id) ?? 0;
          if (count > 0) {
            side.ammo.set(ammoPart.id, count - 1);
            ammoOk = true;
          }
        }
      }
      if (!ammoOk) continue;

      // capacitor requirement for rail
      if (w.kind === "rail") {
        if (side.railCharge < 120) continue;
        side.railCharge = 0;
      }

      // cooldown from rate
      side.weaponCooldown.set(p.id, 1 / (w.rate ?? 1));

      // spawn projectile at muzzle
      const body = side.phys.bodies.get(p.id)?.body;
      if (!body) continue;
      const facing = Math.cos(this.rootPos(side).angle) >= 0 ? 1 : -1;
      const muzzleX = body.getPosition().x + facing * ((d.w * CELL) / 2 + 0.15);
      const muzzleY = body.getPosition().y;
      let speed = 26;
      let dmg = w.dmg;
      if (w.kind === "rail") { speed = 70; }
      if (w.kind === "missile") { speed = 16; }
      if (w.kind === "arc") {
        // cone damage, no projectile body
        const enemy = this.enemyOf(side);
        if (enemy) {
          const epos = this.rootPos(enemy);
          const dist = Math.hypot(epos.x - muzzleX, epos.y - muzzleY);
          if (dist < (w.range ?? 4)) {
            for (const [pid, pb2] of enemy.phys.bodies) {
              if (pb2.destroyed) continue;
              this.damagePart(enemy, pid, w.dmg);
              if (pb2.def.flammable) side.heat.set(pid, (side.heat.get(pid) ?? 20) + 30);
            }
          }
        }
        this.events.onShot?.(side.index, muzzleX, muzzleY);
        continue;
      }
      const vx = facing * speed;
      const proj = makeProjectile(this.world, muzzleX, muzzleY, vx, 1.2, dmg, side.index);
      this.projectiles.push({ body: proj, life: w.kind === "missile" ? 3 : 2.2, dmg, robot: side.index });
      // recoil
      body.applyLinearImpulse(planck.Vec2(-facing * dmg * 0.06, 0), body.getPosition());
      this.events.onShot?.(side.index, muzzleX, muzzleY);
      // heat
      side.heat.set(p.id, Math.min(180, (side.heat.get(p.id) ?? 20) + w.heat * 14));
    }

    // rail capacitors charge
    for (const p of side.bp.parts) {
      const d = part(p.def);
      if (d.capacitor && alive.has(p.id)) {
        side.capBufferKJ = Math.min(d.capacitor.kJ, side.capBufferKJ + d.capacitor.kJ * dt * 0.25);
      }
    }
    if (side.capBufferKJ > 120) side.railCharge = Math.min(150, side.railCharge + 20 * dt);

    // ambient cooling
    const cool = this.coolingFactor(side);
    for (const [pid, t] of side.heat) {
      const nt = Math.max(20, t - (t - 20) * 0.06 * dt * (1 + cool));
      if (nt === 20) side.heat.delete(pid); else side.heat.set(pid, nt);
    }

    // spinner contact bonus: track fast discs and boost their contact damage
    // handled by boosting impulses in applyContactDamage via spinRate check
    this.spinnerHits(side);
  }

  turretTargets = new Map<string, number>();

  private spinnerHits(side: RobotSide) {
    // fast discs apply bonus damage on contact — approximate via body proximity
    for (const [pid2, pb] of side.phys.bodies) {
      void pid2;
      if (pb.destroyed || pb.def.weapon?.kind !== "spinner") continue;
      const spin = pb.spinRate;
      if (spin < 8) continue;
      const pos = pb.body.getPosition();
      const enemy = this.enemyOf(side);
      if (!enemy) continue;
      for (const [eid, eb] of enemy.phys.bodies) {
        if (eb.destroyed) continue;
        const ep = eb.body.getPosition();
        const dist = Math.hypot(ep.x - pos.x, ep.y - pos.y);
        const rr = (pb.def.w + eb.def.w) * CELL * 0.55;
        if (dist < rr) {
          const dmg = (pb.def.weapon!.dmg * Math.min(spin / 20, 1.4)) * 0.9 * dt_60;
          this.damagePart(enemy, eid, dmg);
          side.damageDealt += dmg;
          // knockback
          const dir = Math.sign(ep.x - pos.x) || 1;
          eb.body.applyLinearImpulse(planck.Vec2(dir * spin * eb.body.getMass() * 0.02, spin * eb.body.getMass() * 0.006), eb.body.getPosition());
        }
      }
    }
  }

  private coolingFactor(side: RobotSide): number {
    let c = 0;
    for (const p of side.bp.parts) {
      const d = part(p.def);
      if (d.cooling && side.phys.bodies.get(p.id) && !side.phys.bodies.get(p.id)!.destroyed) {
        const poweredOk = d.cooling.watts ? (side.net.loads.get(p.id)?.powered ?? false) : true;
        c += d.cooling.rate * (poweredOk ? 1 : 0.2);
      }
    }
    return c;
  }

  // ---------------- defeat ----------------

  private evaluateDefeat() {
    for (const side of this.robots) {
      if (!side) continue;
      const alive = new Set<string>();
      for (const [id, pb] of side.phys.bodies) if (!pb.destroyed) alive.add(id);

      // control: any living controller part
      const control = side.bp.parts.some((p) => alive.has(p.id) && (part(p.def).cpu ?? 0) >= 8);

      // mobility: a living wheel still weld-connected to its living drive motor,
      // or a living track unit (self-motorised)
      let mobility = false;
      for (const w of side.phys.wheels) {
        if (!alive.has(w.partId) || !w.motorPartId || !alive.has(w.motorPartId)) continue;
        if (this.weldConnected(side, w.partId, w.motorPartId)) { mobility = true; break; }
      }
      if (!mobility) {
        mobility = side.phys.tracks.some((t) => alive.has(t.partId));
      }

      // offense: a living weapon (non-spinner) with power path, or spinner disc + motor
      let offense = false;
      for (const p of side.bp.parts) {
        if (!alive.has(p.id)) continue;
        const d = part(p.def);
        if (d.weapon && d.weapon.kind !== "spinner" && !PART_EXTRA[p.def]?.barrel && !PART_EXTRA[p.def]?.ammo) { offense = true; break; }
        if (d.weapon?.kind === "spinner") {
          const motorAlive = side.bp.parts.some((q) => alive.has(q.id) && part(q.def).motor && this.weldConnected(side, q.id, p.id));
          if (motorAlive) { offense = true; break; }
        }
      }
      if (!hasWeaponParts(side)) offense = mobility; // rammer

      side.lastResult = { mobility, offense, control };
      const destroyed = !(mobility && (offense || !hasWeaponParts(side))) || !control;
      if (destroyed) {
        side.destroyedTimer += 0.5;
        if (side.destroyedTimer >= KO_CONFIRM) {
          side.defeated = true;
          if (!this.outcome) {
            const other = this.robots[1 - side.index];
            const both = other?.defeated;
            this.outcome = { kind: "ko", winner: both ? null : 1 - side.index, reason: both ? "mutual destruction" : `robot ${side.index + 1} disabled` };
            this.frozen = true;
          }
        }
      } else {
        side.destroyedTimer = 0;
      }
    }
  }

}

function hasWeaponParts(side: RobotSide): boolean {
  return side.bp.parts.some((p) => {
    const d = part(p.def);
    return d.weapon && !PART_EXTRA[p.def]?.barrel && !PART_EXTRA[p.def]?.ammo;
  });
}

const dt_60 = 1 / 60;

export { CELL };
