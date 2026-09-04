// SCRAP & STEEL — game/blueprint.ts
// Immutable-ish build data: grid parts, wires, logic nodes. Canonical hashing,
// migration, save/load, and the preflight engineering checklist.

import { part, type PartDef, type Port } from "./parts";

export interface PlacedPart {
  id: string; // instance uuid
  def: string; // part def id
  x: number; // grid cell, top-left
  y: number;
  rot: 0 | 1 | 2 | 3; // 90° steps (2D: 0 or 2 = flipped, 1/3 = rotated)
}

export interface Wire {
  id: string;
  a: { part: string; port: number };
  b: { part: string; port: number };
}

import type { LogicNode } from "./logic";
export type { LogicNode };

export interface Blueprint {
  version: 2;
  id: string;
  name: string;
  parts: PlacedPart[];
  wires: Wire[];
  logic: LogicNode[];
}

let counter = 0;
export function uid(prefix: string): string {
  counter++;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

export function emptyBlueprint(name = "Untitled Machine"): Blueprint {
  return { version: 2, id: uid("bp"), name, parts: [], wires: [], logic: [] };
}

export function cloneBlueprint(bp: Blueprint): Blueprint {
  return JSON.parse(JSON.stringify(bp));
}

export function migrateBlueprint(raw: unknown): Blueprint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const bp = raw as Record<string, unknown>;
  if (bp.version === 2 && Array.isArray(bp.parts) && Array.isArray(bp.wires) && Array.isArray(bp.logic)) {
    return bp as unknown as Blueprint;
  }
  return null;
}

// ---------- geometry ----------

export function partRect(p: PlacedPart): { x: number; y: number; w: number; h: number } {
  const def = part(p.def);
  // rot 1/3 swap footprint dims (rare in side view, supported for beams)
  if (p.rot === 1 || p.rot === 3) return { x: p.x, y: p.y, w: def.h, h: def.w };
  return { x: p.x, y: p.y, w: def.w, h: def.h };
}

export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function blueprintFootprint(bp: Blueprint) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of bp.parts) {
    const r = partRect(p);
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  if (!bp.parts.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---------- canonical ----------

export function canonicalBlueprint(bp: Blueprint): string {
  const parts = [...bp.parts].sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({ d: p.def, x: p.x, y: p.y, r: p.rot }));
  const wires = [...bp.wires].sort((a, b) => a.id.localeCompare(b.id)).map((w) => [w.a.part, w.a.port, w.b.part, w.b.port]);
  const logic = [...bp.logic].sort((a, b) => a.id.localeCompare(b.id)).map((n) => ({ t: n.type, p: n.params, i: n.in }));
  return JSON.stringify({ v: bp.version, parts, wires, logic });
}

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function blueprintHash(bp: Blueprint): string {
  return hashString(canonicalBlueprint(bp));
}

// ---------- stats ----------

export interface RobotStats {
  mass: number;
  cost: number;
  parts: number;
  genWatts: number;
  energyKJ: number;
  idleWatts: number;
  cpuProvided: number;
  cpuUsed: number;
  wheels: number;
  motors: number;
  weapons: number;
  sensors: number;
}

export function robotStats(bp: Blueprint): RobotStats {
  const st: RobotStats = { mass: 0, cost: 0, parts: bp.parts.length, genWatts: 0, energyKJ: 0, idleWatts: 0, cpuProvided: 0, cpuUsed: bp.logic.length, wheels: 0, motors: 0, weapons: 0, sensors: 0 };
  for (const p of bp.parts) {
    const d = part(p.def);
    st.mass += d.mass;
    st.cost += d.cost;
    if (d.source) { st.genWatts += d.source.watts ?? 0; st.energyKJ += d.source.energyKJ ?? 0; }
    st.idleWatts += d.idleWatts ?? 0;
    st.cpuProvided += d.cpu ?? 0;
    if (d.wheel) st.wheels++;
    if (d.motor) st.motors++;
    if (d.weapon && d.weapon.kind !== "spinner" && !d.barrel) st.weapons++;
    if (d.sensor) st.sensors++;
  }
  return st;
}

// ---------- adjacency ----------

export interface Adjacency { a: string; b: string }

/** Parts that touch edge-to-edge are structurally welded (grid convention). */
export function computeAdjacency(bp: Blueprint): Adjacency[] {
  const out: Adjacency[] = [];
  const rects = bp.parts.map((p) => ({ p, r: partRect(p) }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const A = rects[i]!;
      const B = rects[j]!;
      // edge contact: overlap on one axis with 1-cell contact on the other
      const overlapX = Math.min(A.r.x + A.r.w, B.r.x + B.r.w) - Math.max(A.r.x, B.r.x);
      const overlapY = Math.min(A.r.y + A.r.h, B.r.y + B.r.h) - Math.max(A.r.y, B.r.y);
      const touchX = Math.abs(A.r.x + A.r.w - B.r.x) < 0.01 || Math.abs(B.r.x + B.r.w - A.r.x) < 0.01;
      const touchY = Math.abs(A.r.y + A.r.h - B.r.y) < 0.01 || Math.abs(B.r.y + B.r.h - A.r.y) < 0.01;
      if ((touchX && overlapY >= 0.5) || (touchY && overlapX >= 0.5)) {
        out.push({ a: A.p.id, b: B.p.id });
      }
    }
  }
  return out;
}

/** Port world position in grid-cell coordinates. */
export function portWorldPos(bp: Blueprint, partId: string, portIdx: number): { x: number; y: number } | null {
  const p = bp.parts.find((q) => q.id === partId);
  if (!p) return null;
  const d = part(p.def);
  const port: Port | undefined = d.ports[portIdx];
  if (!port) return null;
  const r = partRect(p);
  let lx: number;
  let ly: number;
  const defW = d.w;
  const defH = d.h;
  if (port.side === 0) { lx = 0; ly = port.off * defH; }
  else if (port.side === 1) { lx = port.off * defW; ly = 0; }
  else if (port.side === 2) { lx = defW; ly = port.off * defH; }
  else { lx = port.off * defW; ly = defH; }
  // rotate local offset by rot (0..3) around footprint; handles swapped dims
  let rx = lx;
  let ry = ly;
  if (p.rot === 1) { const t = lx; rx = defH - ly; ry = t; } // 90° cw approximation
  else if (p.rot === 2) { rx = defW - lx; ry = defH - ly; }
  else if (p.rot === 3) { const t = lx; rx = ly; ry = defW - t; }
  return { x: r.x + rx, y: r.y + ry };
}

// ---------- preflight checklist ----------

export interface ChecklistItem { ok: boolean; warn: boolean; text: string }

export function preflight(bp: Blueprint, maxMass: number): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const st = robotStats(bp);
  const adj = computeAdjacency(bp);

  // connectivity: every part welded (directly or transitively) to the root
  const adjMap = new Map<string, string[]>();
  for (const a of adj) {
    if (!adjMap.has(a.a)) adjMap.set(a.a, []);
    if (!adjMap.has(a.b)) adjMap.set(a.b, []);
    adjMap.get(a.a)!.push(a.b);
    adjMap.get(a.b)!.push(a.a);
  }
  const seen = new Set<string>();
  if (bp.parts.length) {
    const q = [bp.parts[0]!.id];
    seen.add(q[0]!);
    while (q.length) {
      const cur = q.shift()!;
      for (const n of adjMap.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
  }
  const floating = bp.parts.filter((p) => !seen.has(p.id)).length;
  items.push({ ok: floating === 0, warn: false, text: floating === 0 ? "Structural integrity — all parts attached" : `${floating} floating part(s) not attached to the chassis` });

  const hasSource = bp.parts.some((p) => part(p.def).source);
  items.push({ ok: hasSource, warn: false, text: hasSource ? "Power system installed" : "No power source — add a battery or generator" });

  const hasCpu = st.cpuProvided >= st.cpuUsed;
  items.push({ ok: st.cpuProvided > 0 && st.cpuUsed <= st.cpuProvided, warn: st.cpuProvided > 0 && !hasCpu, text: !st.cpuProvided ? "No controller — add a microcontroller" : hasCpu ? `Controller OK — CPU ${Math.round((st.cpuUsed / Math.max(st.cpuProvided, 1)) * 100)}%` : `CPU OVERLOAD — ${st.cpuUsed} nodes on ${st.cpuProvided} slots` });

  const hasTracks = bp.parts.some((p) => part(p.def).track);
  const wiredMotors = countPowered(bp, (d) => !!d.motor);
  if (st.motors === 0 && !hasTracks) {
    items.push({ ok: false, warn: true, text: "No motors — the machine will not move" });
  } else if (hasTracks) {
    items.push({ ok: true, warn: false, text: "Track drive installed" });
  } else {
    items.push({ ok: wiredMotors > 0, warn: true, text: wiredMotors > 0 ? `Drive motors wired (${wiredMotors}/${st.motors})` : "Motors installed but none wired to power" });
  }

  const weaponsPowered = countPowered(bp, (d) => !!d.weapon && !d.barrel && !d.ammo && d.weapon.kind !== "spinner");
  if (st.weapons > 0) items.push({ ok: weaponsPowered > 0, warn: true, text: weaponsPowered > 0 ? "Weapons wired" : "Weapon has no power wire" });

  const ammo = bp.parts.filter((p) => part(p.def).weapon?.ammoCap);
  const guns = bp.parts.filter((p) => ["cannon", "rotary", "rail", "missile"].includes(part(p.def).weapon?.kind ?? ""));
  if (guns.length > 0 && ammo.length === 0) items.push({ ok: false, warn: true, text: "⚠ Weapon has no ammunition box" });

  items.push({ ok: st.mass <= maxMass, warn: false, text: Number.isFinite(maxMass) ? `Mass ${Math.round(st.mass)} / ${maxMass} kg` : `Mass ${Math.round(st.mass)} kg — sandbox (no limit)` });
  return items;
}

/** Parts reachable from any power source through the wire graph. */
export function wiredToPower(bp: Blueprint): Set<string> {
  const powered = new Set<string>();
  const wireAdj = new Map<string, string[]>();
  for (const w of bp.wires) {
    if (!wireAdj.has(w.a.part)) wireAdj.set(w.a.part, []);
    if (!wireAdj.has(w.b.part)) wireAdj.set(w.b.part, []);
    wireAdj.get(w.a.part)!.push(w.b.part);
    wireAdj.get(w.b.part)!.push(w.a.part);
  }
  for (const p of bp.parts) {
    if (!part(p.def).source) continue;
    const seen = new Set<string>([p.id]);
    const q = [p.id];
    while (q.length) {
      const cur = q.shift()!;
      powered.add(cur);
      for (const n of wireAdj.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
  }
  return powered;
}

function countPowered(bp: Blueprint, pred: (d: PartDef) => boolean): number {
  const powered = wiredToPower(bp);
  let n = 0;
  for (const p of bp.parts) {
    if (pred(part(p.def)) && powered.has(p.id)) n++;
  }
  return n;
}

// ---------- persistence ----------

const BP_KEY = "scrap_blueprints_v2";

export interface SavedBlueprint { id: string; name: string; bp: Blueprint; hash: string }

export function listSaved(): SavedBlueprint[] {
  try {
    return JSON.parse(localStorage.getItem(BP_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveBlueprint(bp: Blueprint): void {
  const list = listSaved().filter((s) => s.id !== bp.id);
  list.unshift({ id: bp.id, name: bp.name, bp, hash: blueprintHash(bp) });
  localStorage.setItem(BP_KEY, JSON.stringify(list.slice(0, 40)));
}

export function deleteBlueprint(id: string): void {
  localStorage.setItem(BP_KEY, JSON.stringify(listSaved().filter((s) => s.id !== id)));
}
