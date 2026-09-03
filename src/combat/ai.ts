// SCRAP AND STEEL — combat/ai.ts
// Local opponent for solo play: a prebuilt blueprint (same schema as players) plus a
// simple behavior controller. Builds are data, not code.

import type { Blueprint, PartInstance, WireInstance, Binding } from "../blueprint/types";
import { makeId } from "../blueprint/types";

function part(defId: string, pos: [number, number, number], rot: 0 | 1 | 2 | 3 = 0): PartInstance {
  return { id: makeId(), defId, pos, rot };
}

export function buildAiBot(): Blueprint {
  const parts: PartInstance[] = [];
  const wires: WireInstance[] = [];
  const bindings: Binding[] = [];

  // positions are min-corners in cells. Layout (y=0 deck):
  //   controller (0,-1) · core (0,0) · batteries (-1,0) (1,0)
  //   motors at (±1,-1) and (±1,1); wheels outboard; wedge front at (+z).
  const controller = part("motor_controller", [0, 0, -1]);
  const core = part("control_core", [0, 0, 0]);
  const bat1 = part("battery_hidisc", [-1, 0, 0]);
  const bat2 = part("battery_compact", [1, 0, 0]);
  const mFL = part("motor_torque", [-1, 0, -1]);
  const mFR = part("motor_torque", [1, 0, -1]);
  const mRL = part("motor_torque", [-1, 0, 1]);
  const mRR = part("motor_torque", [1, 0, 1]);
  const wFL = part("wheel_rubber", [-2, 0, -1]);
  const wFR = part("wheel_rubber", [2, 0, -1]);
  const wRL = part("wheel_rubber", [-2, 0, 1]);
  const wRR = part("wheel_rubber", [2, 0, 1]);
  const wedge = part("armor_wedge", [-1, 0, 2]);
  const armorFront = part("armor_steel", [1, 0, 2]);
  const drum = part("spinner_drum", [0, 1, 0]);
  parts.push(
    controller, core, bat1, bat2,
    mFL, mFR, mRL, mRR,
    wFL, wFR, wRL, wRR,
    wedge, armorFront, drum,
  );

  const W = (from: PartInstance, to: PartInstance, gauge: WireInstance["gauge"]) =>
    wires.push({ id: makeId("w"), from: from.id, to: to.id, gauge });

  W(bat1, bat2, "heavy");
  W(bat1, controller, "heavy");
  W(bat1, core, "medium");
  W(controller, mFL, "medium");
  W(controller, mFR, "medium");
  W(bat2, mRL, "medium");
  W(bat2, mRR, "medium");
  W(bat1, drum, "heavy");

  for (const m of [mFL, mFR, mRL, mRR]) {
    bindings.push({ channel: "throttle", targetPartId: m.id });
    bindings.push({ channel: "steer", targetPartId: m.id });
  }
  bindings.push({ channel: "fire", targetPartId: drum.id });

  return { schemaVersion: 1, id: makeId("bp"), name: "Scrapper", parts, wires, bindings };
}

/** Simple pursuit AI: charge the opponent, keep the weapon spinning, lift when close. */
export class AiController {
  update(self: { x: number; z: number; yaw: number }, opp: { x: number; z: number }): {
    throttle: number;
    steer: number;
    fire: boolean;
    lift: boolean;
  } {
    const dx = opp.x - self.x;
    const dz = opp.z - self.z;
    const dist = Math.hypot(dx, dz);
    const desired = Math.atan2(dx, dz);
    let err = desired - self.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const steer = Math.max(-1, Math.min(1, err * 1.8));
    return {
      throttle: dist > 1.4 ? 1 : 0.15,
      steer,
      fire: true,
      lift: dist < 2.2,
    };
  }
}
