// SCRAP AND STEEL — sim/power.ts
// Directed power/control graph over the blueprint. Loads request power; the solver
// allocates available source output, applies wire capacity limits, and reports which
// loads are powered, derated or unpowered. Runs at ~15 Hz during simulation and once
// for preflight. Deliberately NOT a circuit simulator — gameplay-readable energy flow.

import type { Blueprint } from "../blueprint/types";
import { PART_DEFS, WIRE_CAP_W } from "../content/parts";

export interface PowerLoadState {
  partId: string;
  requestedW: number;
  deliveredW: number;
  regulated: boolean; // had a controller on path
  powered: boolean;
}

export interface WireState {
  id: string;
  capacityW: number;
  loadW: number; // peak assigned load this solve
  temp: number; // 0..1 normalized heat
  tripped: boolean;
  tripTimer: number;
}

export interface PowerNet {
  loads: Map<string, PowerLoadState>;
  wires: Map<string, WireState>;
  sourcePeakW: number;
  sourceEnergyKJ: number;
  totalDemandW: number;
  totalDeliveredW: number;
}

export interface LoadRequest {
  partId: string;
  watts: number;
}

const TRIP_TIME = 4.0;
const WIRE_HEAT_PER_OVERLOAD = 0.9; // fraction of temp gained per second at 100% overload
const WIRE_COOL_RATE = 0.35;

function adjacency(bp: Blueprint): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const w of bp.wires) {
    if (!g.has(w.from)) g.set(w.from, []);
    if (!g.has(w.to)) g.set(w.to, []);
    g.get(w.from)!.push(w.to);
    g.get(w.to)!.push(w.from);
  }
  return g;
}

/**
 * Solve power for one tick.
 * - `alive`: part ids that still exist (not destroyed/detached)
 * - `intactWires`: wire ids whose physical path is unbroken and not tripped
 * - `requests`: per-load power demand this tick
 * - `dt`: seconds since last solve (wire heat integration)
 */
export function solvePower(
  bp: Blueprint,
  alive: Set<string>,
  intactWires: Set<string>,
  requests: LoadRequest[],
  prev?: PowerNet | null,
  dt = 0,
): PowerNet {
  const net: PowerNet = {
    loads: new Map(),
    wires: new Map(),
    sourcePeakW: 0,
    sourceEnergyKJ: 0,
    totalDemandW: 0,
    totalDeliveredW: 0,
  };

  // carry wire thermal state forward
  for (const w of bp.wires) {
    const p = prev?.wires.get(w.id);
    net.wires.set(w.id, {
      id: w.id,
      capacityW: WIRE_CAP_W[w.gauge],
      loadW: 0,
      temp: p ? p.temp : 0,
      tripped: p ? p.tripped : false,
      tripTimer: p ? p.tripTimer : 0,
    });
  }

  // sources: batteries with remaining energy (energy accounting done by caller via requests-side)
  for (const p of bp.parts) {
    if (!alive.has(p.id)) continue;
    const def = PART_DEFS[p.defId];
    if (def?.source) {
      const energy = prev?.sourceEnergyKJ ?? def.source.energy;
      net.sourceEnergyKJ = energy; // refined below by caller for multi-source
      net.sourcePeakW += def.source.peakW;
    }
  }

  const adj = adjacency(bp);

  // For each load, BFS to nearest surviving source through intact, untripped wires.
  // Track the wire path so wire loads can be accumulated, and detect controller presence.
  interface LoadResult {
    partId: string;
    watts: number;
    powered: boolean;
    regulated: boolean;
    pathWires: string[];
  }
  const results: LoadResult[] = [];

  const sourceIds = new Set(bp.parts.filter((p) => alive.has(p.id) && PART_DEFS[p.defId]?.source).map((p) => p.id));
  const destroyedSources = bp.parts.some((p) => PART_DEFS[p.defId]?.source) && sourceIds.size === 0;

  for (const req of requests) {
    const load: LoadResult = { partId: req.partId, watts: req.watts, powered: false, regulated: false, pathWires: [] };
    net.totalDemandW += req.watts;
    if (sourceIds.size > 0 && !destroyedSources) {
      // BFS from load through wire graph
      const prevMap = new Map<string, { node: string; wire: string }>();
      const q: string[] = [req.partId];
      const seen = new Set([req.partId]);
      let found: string | null = null;
      while (q.length && !found) {
        const cur = q.shift()!;
        for (const next of adj.get(cur) ?? []) {
          if (seen.has(next)) continue;
          const wire = bp.wires.find((w) => (w.from === cur && w.to === next) || (w.from === next && w.to === cur));
          if (!wire || !intactWires.has(wire.id) || net.wires.get(wire.id)?.tripped) continue;
          seen.add(next);
          prevMap.set(next, { node: cur, wire: wire.id });
          if (sourceIds.has(next)) {
            found = next;
            break;
          }
          q.push(next);
        }
      }
      if (found) {
        // walk path back to source
        const pathWires: string[] = [];
        let cur = found;
        let regulated = false;
        while (cur !== req.partId) {
          const step = prevMap.get(cur);
          if (!step) break;
          pathWires.push(step.wire);
          const nodePart = bp.parts.find((p) => p.id === cur);
          if (nodePart && PART_DEFS[nodePart.defId]?.controller) regulated = true;
          cur = step.node;
        }
        load.powered = true;
        load.regulated = regulated;
        load.pathWires = pathWires;
      }
    }
    results.push(load);
  }

  // Allocate: global scale from source peak, then per-wire capacity constraints.
  const peak = Math.max(net.sourcePeakW, 1);
  const demanded = results.reduce((s, r) => s + (r.powered ? r.watts : 0), 0);
  const globalScale = demanded > peak ? peak / demanded : 1;

  // wire usage count
  const wireLoad = new Map<string, number>();
  for (const r of results) {
    if (!r.powered) continue;
    const delivered = r.watts * globalScale * (r.regulated ? 1 : 0.6);
    for (const wid of r.pathWires) wireLoad.set(wid, (wireLoad.get(wid) ?? 0) + delivered);
  }

  // Wire overload → derate loads whose path includes an overloaded wire (iterative soft cap)
  const overloaded = new Map<string, number>(); // wireId -> scale
  for (const [wid, load] of wireLoad) {
    const st = net.wires.get(wid);
    if (st && load > st.capacityW) overloaded.set(wid, st.capacityW / load);
  }
  function pathScale(r: LoadResult): number {
    let s = 1;
    for (const wid of r.pathWires) {
      const o = overloaded.get(wid);
      if (o !== undefined) s = Math.min(s, o);
    }
    return s;
  }

  for (const r of results) {
    let delivered = 0;
    if (r.powered) {
      delivered = r.watts * globalScale * (r.regulated ? 1 : 0.6) * pathScale(r);
      // wire load tracks the UNCLAMPED demand: a wire asked for more than it can
      // carry heats up even though delivery is limited (protection, not physics).
      const unclamped = r.watts * globalScale * (r.regulated ? 1 : 0.6);
      for (const wid of r.pathWires) {
        const st = net.wires.get(wid);
        if (st) st.loadW = Math.max(st.loadW, unclamped);
      }
    }
    net.loads.set(r.partId, {
      partId: r.partId,
      requestedW: r.watts,
      deliveredW: delivered,
      regulated: r.regulated,
      powered: r.powered && delivered > 1,
    });
    net.totalDeliveredW += delivered;
  }

  // wire thermal integration
  for (const st of net.wires.values()) {
    if (st.tripped) {
      st.tripTimer -= dt;
      if (st.tripTimer <= 0) st.tripped = false;
      st.temp = Math.max(0, st.temp - WIRE_COOL_RATE * dt);
      continue;
    }
    const cap = Math.max(st.capacityW, 1);
    const overload = st.loadW / cap - 1;
    if (overload > 0) {
      st.temp = Math.min(1.2, st.temp + WIRE_HEAT_PER_OVERLOAD * overload * dt);
      if (st.temp >= 1) {
        st.tripped = true;
        st.tripTimer = TRIP_TIME;
      }
    } else {
      st.temp = Math.max(0, st.temp - WIRE_COOL_RATE * dt);
    }
  }

  return net;
}

export function createPowerNet(): PowerNet {
  return {
    loads: new Map(),
    wires: new Map(),
    sourcePeakW: 0,
    sourceEnergyKJ: 0,
    totalDemandW: 0,
    totalDeliveredW: 0,
  };
}

/** Preflight-time static analysis of the power graph. */
export function analyzePowerGraph(bp: Blueprint): { issues: PreflightPowerIssue[]; poweredMotors: Set<string>; poweredWeapons: Set<string> } {
  const issues: PreflightPowerIssue[] = [];
  const dead = solvePower(bp, new Set(bp.parts.map((p) => p.id)), new Set(bp.wires.map((w) => w.id)), [], undefined, 0);
  const sources = bp.parts.filter((p) => PART_DEFS[p.defId]?.source);
  const adj = adjacency(bp);

  function reachableFrom(partId: string): Set<string> {
    const seen = new Set([partId]);
    const q = [partId];
    while (q.length) {
      const cur = q.shift()!;
      for (const n of adj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    return seen;
  }

  const motors = bp.parts.filter((p) => PART_DEFS[p.defId]?.motor);
  const weapons = bp.parts.filter((p) => PART_DEFS[p.defId]?.weapon || PART_DEFS[p.defId]?.lifter);
  const poweredMotors = new Set<string>();
  const poweredWeapons = new Set<string>();

  if (sources.length === 0 && (motors.length > 0 || weapons.length > 0)) {
    issues.push({ severity: "critical", message: "No battery: motors and weapons have no power source." });
  }
  if (bp.wires.length === 0 && (motors.length > 0 || weapons.length > 0) && sources.length > 0) {
    issues.push({ severity: "critical", message: "Battery is not wired to anything. Use the Wire tool." });
  }

  for (const m of motors) {
    const ok = sources.some((s) => reachableFrom(m.id).has(s.id));
    if (ok) {
      poweredMotors.add(m.id);
    } else {
      issues.push({ severity: "critical", message: `Motor "${PART_DEFS[m.defId]?.name ?? "part"}" has no wired path to a battery.`, partId: m.id });
    }
  }
  for (const w of weapons) {
    const ok = sources.some((s) => reachableFrom(w.id).has(s.id));
    if (ok) poweredWeapons.add(w.id);
    else issues.push({ severity: "critical", message: `Weapon "${PART_DEFS[w.defId]?.name ?? "part"}" has no wired path to a battery.`, partId: w.id });
  }
  void dead;
  return { issues, poweredMotors, poweredWeapons };
}

export interface PreflightPowerIssue {
  severity: "blocker" | "critical" | "warning" | "suggestion";
  message: string;
  partId?: string;
}
