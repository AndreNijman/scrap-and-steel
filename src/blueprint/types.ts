// SCRAP AND STEEL — blueprint/types.ts
// Blueprint = immutable build data. NO runtime values (temperature, charge, damage,
// velocity) may ever be stored here. Runtime state lives in sim/runtime.ts.

import { PART_DEFS, WIRE_COST, type WireGauge } from "../content/parts";

export interface PartInstance {
  id: string;
  defId: string;
  /** position in grid cells; cell size 0.5 m. Origin at robot spawn center, y up. */
  pos: [number, number, number];
  /** rotation around Y axis in 90-degree steps (0..3) */
  rot: 0 | 1 | 2 | 3;
}

export interface WireInstance {
  id: string;
  from: string; // part id
  to: string; // part id
  gauge: WireGauge;
}

export type InputChannel = "throttle" | "steer" | "fire" | "lift";

export interface Binding {
  channel: InputChannel;
  targetPartId: string; // motor or weapon part
}

export interface Blueprint {
  schemaVersion: 1;
  id: string;
  name: string;
  parts: PartInstance[];
  wires: WireInstance[];
  bindings: Binding[];
}

export interface BuildSettings {
  buildTimeSec: number; // 60..900
  budgetSp: number; // 300..2000
  partLimit: number; // 60..120
  arena: string;
  combatLimitSec: number; // 120..600
  rematch: "rebuild" | "same";
}

export const DEFAULT_SETTINGS: BuildSettings = {
  buildTimeSec: 420,
  budgetSp: 1000,
  partLimit: 120,
  arena: "foundry",
  combatLimitSec: 360,
  rematch: "rebuild",
};

export const CELL = 0.5;

let uuidCounter = 0;
export function makeId(prefix = "p"): string {
  uuidCounter++;
  return `${prefix}${Date.now().toString(36)}${uuidCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function emptyBlueprint(name = "Untitled Robot"): Blueprint {
  return { schemaVersion: 1, id: makeId("bp"), name, parts: [], wires: [], bindings: [] };
}

export function cloneBlueprint(bp: Blueprint): Blueprint {
  return JSON.parse(JSON.stringify(bp)) as Blueprint;
}

/** Schema migrations. Each version has an explicit function + golden fixture. */
export function migrateBlueprint(raw: unknown): Blueprint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const bp = raw as Record<string, unknown>;
  if (bp.schemaVersion === 1 && Array.isArray(bp.parts)) return bp as unknown as Blueprint;
  return null; // unknown future schema: reject, never silently mutate
}

export type { WireGauge };

// ---- validation / budget ----

export interface PreflightIssue {
  severity: "blocker" | "critical" | "warning" | "suggestion";
  message: string;
  partId?: string;
}

export function blueprintCost(bp: Blueprint): number {
  return bp.parts.reduce((s, p) => s + (PART_DEFS[p.defId]?.cost ?? 0), 0) + bp.wires.length * WIRE_COST;
}

export function blueprintMass(bp: Blueprint): number {
  return bp.parts.reduce((s, p) => s + (PART_DEFS[p.defId]?.mass ?? 0), 0);
}
