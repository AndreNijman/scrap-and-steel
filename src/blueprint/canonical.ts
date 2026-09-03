// SCRAP AND STEEL — blueprint/canonical.ts
// Canonical serialization: two equivalent blueprints must always produce the same
// string and the same hash. Blueprint entries are stored canonically from creation,
// but canonicalize() re-sorts defensively before hashing/exporting.

import type { Blueprint } from "./types";
import { PART_DEFS } from "../content/parts";

export function canonicalize(bp: Blueprint): Blueprint {
  const parts = [...bp.parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const wires = [...bp.wires].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bindings = [...bp.bindings].sort(
    (a, b) => a.channel.localeCompare(b.channel) || (a.targetPartId < b.targetPartId ? -1 : 1),
  );
  return {
    schemaVersion: 1,
    id: bp.id,
    name: bp.name,
    parts,
    wires,
    bindings,
  };
}

/** Deterministic JSON with sorted object keys (canonical blueprint is already sorted). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/** FNV-1a 32-bit, hex. Fast, sync, deterministic across browsers and Node. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function blueprintHash(bp: Blueprint): string {
  return hashString(stableStringify(canonicalize(bp)));
}

export function blueprintSummary(bp: Blueprint) {
  const byCategory: Record<string, number> = {};
  let mass = 0;
  for (const p of bp.parts) {
    const def = PART_DEFS[p.defId];
    if (!def) continue;
    byCategory[def.category] = (byCategory[def.category] ?? 0) + 1;
    mass += def.mass;
  }
  return { parts: bp.parts.length, wires: bp.wires.length, mass, byCategory };
}
