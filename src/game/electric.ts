// SCRAP & STEEL — game/electric.ts
// Power network: sources feed buses through wires; loads draw; fuses protect;
// heat builds; voltage sags. Solved at 15 Hz. Deliberately a gameplay model,
// not SPICE — but every failure mode is real: overload trips fuses, undersized
// wires burn, greedy motors sag the bus.

import type { Blueprint, PlacedPart } from "./blueprint";
import { part, CELL } from "./parts";

export const BUS_VOLTAGE = 48; // nominal volts
const FUSE_TRIP_COOL = 3.0; // seconds a tripped fuse stays open
const WIRE_COOL = 0.4;

export interface WireRuntime {
  id: string;
  amps: number; // peak assigned current
  temp: number; // 0..1
  tripped: boolean;
  tripTimer: number;
  broken: boolean;
}

export interface SourceRuntime {
  partId: string;
  watts: number; // generation capability this tick
  energyKJ: number; // stored (batteries)
  fuelSec: number;
  heat: number;
}

export interface LoadRuntime {
  partId: string;
  watts: number; // requested
  deliveredWatts: number;
  powered: boolean;
  voltage: number;
  amps: number;
}

export interface PowerNet {
  sources: Map<string, SourceRuntime>;
  loads: Map<string, LoadRuntime>;
  wires: Map<string, WireRuntime>;
  generation: number;
  consumption: number;
  storedKJ: number;
  capacityKJ: number;
  busVoltage: number;
  busCurrent: number;
  efficiency: number;
  anySource: boolean;
}

export function createNet(bp: Blueprint): PowerNet {
  const net: PowerNet = {
    sources: new Map(), loads: new Map(), wires: new Map(),
    generation: 0, consumption: 0, storedKJ: 0, capacityKJ: 0,
    busVoltage: BUS_VOLTAGE, busCurrent: 0, efficiency: 100, anySource: false,
  };
  for (const p of bp.parts) {
    const d = part(p.def);
    if (d.source) {
      net.sources.set(p.id, { partId: p.id, watts: d.source.watts ?? 0, energyKJ: d.source.energyKJ ?? 0, fuelSec: d.source.fuelSec ?? 0, heat: 0 });
      net.capacityKJ += d.source.energyKJ ?? 0;
      net.storedKJ += d.source.energyKJ ?? 0;
      net.anySource = true;
    }
    if (d.source?.watts) net.anySource = true;
  }
  for (const w of bp.wires) net.wires.set(w.id, { id: w.id, amps: 0, temp: 0, tripped: false, tripTimer: 0, broken: false });
  return net;
}

/** current capacity of a wire, amps — all player wires are "standard loom" (25 A);
 *  heavy draws need parallel runs, a bus bar, or a dist board. */
const WIRE_AMPS = 25;

/** Solve the network. `demands` maps partId -> requested watts (0 = idle).
 *  `aliveParts`: parts that still exist physically. `dt` in seconds. */
export function solveNet(
  bp: Blueprint,
  net: PowerNet,
  demands: Map<string, number>,
  aliveParts: Set<string>,
  dt: number,
  regulatorCount: number,
) {
  net.generation = 0;
  net.consumption = 0;
  net.busCurrent = 0;

  // 1. generators: fuel burn only when loads demand
  let availableWatts = 0;
  for (const [id, src] of net.sources) {
    const p = bp.parts.find((q) => q.id === id);
    const d = p ? part(p.def) : null;
    if (!p || !aliveParts.has(id) || !d) continue;
    if (!d.source) continue;
    const isBattery = d.source.energyKJ !== undefined;
    const isFuel = d.source.watts !== undefined && d.source.fuelSec !== undefined;
    const isSolar = d.source.watts !== undefined && !d.source.fuelSec && !isBattery;
    if (isBattery) {
      availableWatts += 6000; // batteries can burst up to 6 kW each
    } else if (isFuel) {
      const demandShare = Math.min(d.source.watts ?? 0, 6500);
      availableWatts += demandShare;
      src.watts = demandShare;
    } else if (isSolar) {
      availableWatts += d.source.watts ?? 0;
    }
  }

  // 2. total demand from active loads
  let demand = 0;
  for (const [partId, watts] of demands) {
    if (!aliveParts.has(partId)) continue;
    if (watts > 0) demand += watts;
  }

  // 3. battery drain: batteries deliver whatever generation does not cover
  let nonBatteryGen = 0;
  for (const [id] of net.sources) {
    const p = bp.parts.find((q) => q.id === id);
    const d = p ? part(p.def) : null;
    if (!d?.source) continue;
    if (d.source.watts !== undefined) nonBatteryGen += Math.min(d.source.watts, demand);
  }
  const batteryDrain = Math.max(0, demand - nonBatteryGen);
  let storedKJ = 0;
  let capacityKJ = 0;
  for (const src of net.sources.values()) {
    const p = bp.parts.find((q) => q.id === src.partId);
    const d = p ? part(p.def) : null;
    if (!d?.source) continue;
    if (d.source.energyKJ !== undefined) capacityKJ += d.source.energyKJ;
  }
  // drain proportionally from batteries
  if (batteryDrain > 0) {
    for (const src of net.sources.values()) {
      const p = bp.parts.find((q) => q.id === src.partId);
      const d = p ? part(p.def) : null;
      if (!d?.source || d.source.energyKJ === undefined) continue;
      if (!aliveParts.has(src.partId)) continue;
      const share = batteryDrain * dt / 1000; // kJ
      src.energyKJ = Math.max(0, src.energyKJ - share);
    }
  }
  for (const src of net.sources.values()) {
    const p = bp.parts.find((q) => q.id === src.partId);
    const d = p ? part(p.def) : null;
    if (!d?.source?.energyKJ) continue;
    if (!aliveParts.has(src.partId)) continue;
    storedKJ += src.energyKJ;
  }
  net.storedKJ = storedKJ;
  net.capacityKJ = capacityKJ;

  // voltage sag: heavy demand on weak supply
  const deficitRatio = demand > 0 ? Math.max(0, (demand - availableWatts - storedKJ * 1000 * 0.1) / demand) : 0;
  const sag = Math.min(0.45, deficitRatio * 0.6 + (regulatorCount > 0 ? 0 : 0.08));
  net.busVoltage = BUS_VOLTAGE * (1 - sag) * (storedKJ <= 0 && availableWatts < demand && !net.anySource ? 0 : 1);
  net.generation = Math.min(availableWatts, demand);
  net.consumption = demand;
  net.busCurrent = net.busVoltage > 0 ? (demand / Math.max(net.busVoltage, 1)) : 0;
  net.efficiency = demand > 0 ? Math.round(Math.max(50, 100 - sag * 100)) : 100;

  // 4. loads: powered if reachable from a live source through untripped wires
  const wireAdj = new Map<string, { to: string; wireId: string }[]>();
  for (const w of bp.wires) {
    const rt = net.wires.get(w.id);
    if (!rt || rt.broken) continue;
    if (!wireAdj.has(w.a.part)) wireAdj.set(w.a.part, []);
    if (!wireAdj.has(w.b.part)) wireAdj.set(w.b.part, []);
    wireAdj.get(w.a.part)!.push({ to: w.b.part, wireId: w.id });
    wireAdj.get(w.b.part)!.push({ to: w.a.part, wireId: w.id });
  }

  // per-load BFS to source
  const loadAssign = new Map<string, number>(); // wireId -> amps
  for (const [partId, watts] of demands) {
    if (!aliveParts.has(partId) || watts <= 0) continue;
    const lr: LoadRuntime = net.loads.get(partId) ?? { partId, watts: 0, deliveredWatts: 0, powered: false, voltage: 0, amps: 0 };
    lr.watts = watts;
    // BFS
    const prev = new Map<string, { node: string; wireId: string }>();
    const seen = new Set<string>([partId]);
    const q: string[] = [partId];
    let source: string | null = null;
    while (q.length && !source) {
      const cur = q.shift()!;
      for (const edge of wireAdj.get(cur) ?? []) {
        if (seen.has(edge.to)) continue;
        const wr = net.wires.get(edge.wireId);
        if (!wr || wr.tripped) continue;
        const destDef = part(bp.parts.find((x) => x.id === edge.to)!.def);
        // fuse parts block when tripped (modelled as wire-less hop check below)
        seen.add(edge.to);
        prev.set(edge.to, { node: cur, wireId: edge.wireId });
        const dd = destDef;
        if (dd.source) { source = edge.to; break; }
        q.push(edge.to);
      }
    }
    if (source) {
      // walk back, accumulate wire loading, check fuses on path
      let cur = source;
      let pathOk = true;
      const path: string[] = [];
      while (cur !== partId) {
        const step = prev.get(cur);
        if (!step) { pathOk = false; break; }
        path.push(step.wireId);
        const nodePart = bp.parts.find((x) => x.id === cur)!;
        const nd = part(nodePart.def);
        if (nd.fuse) {
          const fr = fuseState(net, nodePart.id);
          if (fr.tripped) { pathOk = false; break; }
        }
        cur = step.node;
      }
      if (pathOk) {
        const amps = watts / Math.max(net.busVoltage, 1);
        for (const wid of path) {
          loadAssign.set(wid, (loadAssign.get(wid) ?? 0) + amps);
        }
        lr.powered = true;
        lr.deliveredWatts = watts;
        lr.voltage = net.busVoltage;
        lr.amps = amps;
        net.consumption = net.consumption; // unchanged
      } else {
        lr.powered = false;
        lr.deliveredWatts = 0;
      }
    } else {
      lr.powered = net.anySource ? false : false;
      lr.deliveredWatts = 0;
      lr.powered = false;
    }
    net.loads.set(partId, lr);
  }

  // 5. wire heating / tripping from assigned amps
  for (const wr of net.wires.values()) {
    wr.amps = loadAssign.get(wr.id) ?? 0;
    if (wr.broken) continue;
    if (wr.tripped) {
      wr.tripTimer -= dt;
      if (wr.tripTimer <= 0) wr.tripped = false;
      wr.temp = Math.max(0, wr.temp - WIRE_COOL * dt);
      continue;
    }
    const overload = wr.amps / WIRE_AMPS - 0.8; // heats above 80% load
    if (overload > 0) {
      wr.temp = Math.min(1.2, wr.temp + overload * 0.8 * dt);
      if (wr.temp >= 1) { wr.tripped = true; wr.tripTimer = FUSE_TRIP_COOL; }
    } else {
      wr.temp = Math.max(0, wr.temp - WIRE_COOL * dt);
    }
  }
  net.efficiency = Math.max(50, Math.min(100, net.efficiency));
}

// fuse state (per part)
const fuseStates = new WeakMap<PowerNet, Map<string, { tripped: boolean; timer: number }>>();
function fuseState(net: PowerNet, partId: string): { tripped: boolean; timer: number } {
  let m = fuseStates.get(net);
  if (!m) { m = new Map(); fuseStates.set(net, m); }
  let f = m.get(partId);
  if (!f) { f = { tripped: false, timer: 0 }; m.set(partId, f); }
  return f;
}

/** Integrate fuse behaviour: a fuse trips when downstream current exceeds rating. */
export function stepFuses(bp: Blueprint, net: PowerNet, dt: number) {
  for (const p of bp.parts) {
    const d = part(p.def);
    if (!d.fuse) continue;
    const f = fuseState(net, p.id);
    if (f.tripped) {
      f.timer -= dt;
      if (f.timer <= 0) f.tripped = false;
      continue;
    }
    // amps flowing through this fuse = sum of loads whose BFS path used it
    // (approximation: sum of all loads' amps / number of fuses on the net)
    let totalAmps = 0;
    let fuseCount = 0;
    for (const lr of net.loads.values()) if (lr.powered) totalAmps += lr.amps;
    for (const q of bp.parts) if (part(q.def).fuse) fuseCount++;
    const share = fuseCount > 0 ? totalAmps / fuseCount : 0;
    if (share > d.fuse.amps) {
      f.tripped = true;
      f.timer = FUSE_TRIP_COOL;
    }
  }
}

export function isFuseTripped(net: PowerNet, partId: string): boolean {
  return fuseState(net, partId).tripped;
}

/** helper: world position of a port (meters) — used by the renderer + wire damage */
export function portMeterPos(bp: Blueprint, partId: string, portIdx: number): { x: number; y: number } | null {
  const p: PlacedPart | undefined = bp.parts.find((q) => q.id === partId);
  if (!p) return null;
  const d = part(p.def);
  const port = d.ports[portIdx];
  if (!port) return null;
  const defW = d.w;
  const defH = d.h;
  let lx: number;
  let ly: number;
  if (port.side === 0) { lx = 0; ly = port.off * defH; }
  else if (port.side === 1) { lx = port.off * defW; ly = 0; }
  else if (port.side === 2) { lx = defW; ly = port.off * defH; }
  else { lx = port.off * defW; ly = defH; }
  let rx = lx;
  let ry = ly;
  if (p.rot === 1) { const t = lx; rx = defH - ly; ry = t; }
  else if (p.rot === 2) { rx = defW - lx; ry = defH - ly; }
  else if (p.rot === 3) { const t = lx; rx = ly; ry = defW - t; }
  return { x: (p.x + rx) * CELL, y: (p.y + ry) * CELL };
}
