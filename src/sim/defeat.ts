// SCRAP AND STEEL — sim/defeat.ts
// Defeat is PHYSICAL incapacity, not a health bar. Battery depletion alone is never
// destruction: an empty battery does not invalidate the hardware power path.
// A robot is "destroyed" when it has neither meaningful mobility/recovery nor
// meaningful offense, continuously, for the confirmation window (enforced by caller).

import { RobotRuntime } from "./robot";
import { PART_DEFS } from "../content/parts";

export interface DefeatResult {
  mobility: boolean;
  offense: boolean;
  control: boolean;
  destroyed: boolean;
}

/**
 * mobility: at least one surviving mechanically connected drive mechanism (motor+wheel)
 *   that is weld-connected to the structure, on an intact wire path to surviving battery
 *   HARDWARE (charge irrelevant).
 * offense: at least one surviving weapon path (weapon or saw with power path), OR the
 *   robot has no weapon parts at all and mobility counts as its offense (rammer).
 * control: at least one surviving control core weld-connected to the relevant mechanism.
 */
export function evaluateDefeat(rt: RobotRuntime, functional: (rt: RobotRuntime) => Set<string>): DefeatResult {
  const alive = rt.aliveParts();
  const func = functional(rt);

  // intact wire graph over surviving parts
  const wireAdj = new Map<string, string[]>();
  for (const w of rt.bp.wires) {
    if (!alive.has(w.from) || !alive.has(w.to)) continue;
    if (!wireAdj.has(w.from)) wireAdj.set(w.from, []);
    if (!wireAdj.has(w.to)) wireAdj.set(w.to, []);
    wireAdj.get(w.from)!.push(w.to);
    wireAdj.get(w.to)!.push(w.from);
  }
  function hasWirePath(from: string): boolean {
    if (!alive.has(from)) return false;
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const cur = q.shift()!;
      if (rt.batteries.has(cur) && alive.has(cur)) return true;
      for (const n of wireAdj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    return false;
  }

  // mobility: a motor+wheel pair where both survive and motor is functional + wired
  let mobility = false;
  for (const wheel of rt.wheels) {
    const m = rt.parts.get(wheel.motorPartId);
    const w = rt.parts.get(wheel.wheelPartId);
    if (!m || m.destroyed || !w || w.destroyed) continue;
    if (!func.has(wheel.motorPartId)) continue;
    if (hasWirePath(wheel.motorPartId)) {
      mobility = true;
      break;
    }
  }

  // control: surviving core that is functional (weld-connected to itself counts)
  let control = false;
  for (const c of rt.cores) {
    const part = rt.parts.get(c);
    if (part && !part.destroyed && func.has(c)) {
      control = true;
      break;
    }
  }

  // offense: any surviving weapon/lifter with wire path + functional, else rammer rule
  const hasWeaponParts = [...rt.parts.values()].some((p) => p.def.weapon || p.def.lifter);
  let offense = false;
  if (hasWeaponParts) {
    for (const p of rt.parts.values()) {
      if (p.destroyed || !(p.def.weapon || p.def.lifter)) continue;
      if (!func.has(p.partId)) continue;
      if (hasWirePath(p.partId)) {
        offense = true;
        break;
      }
    }
  } else {
    offense = mobility; // pure rammer: mobility is the offense
  }

  const destroyed = !mobility && !offense;
  return { mobility, offense, control, destroyed };
}

void PART_DEFS;
