// SCRAP & STEEL — game/builder.ts
// Build-mode controller: grid placement, selection, multi-select, copy/paste,
// rotation, deletion, wire mode. All edits are transactional (undo/redo).

import type { Blueprint, PlacedPart, Wire } from "./blueprint";
import { uid, partRect, rectsOverlap, partRect as rectOf, computeAdjacency, portWorldPos, robotStats } from "./blueprint";
import { part, CELL } from "./parts";

export type Tool = "place" | "select" | "wire" | "delete";

export interface BuilderEvents {
  onChange?: () => void;
  onMessage?: (msg: string) => void;
  onAction?: (a: "place" | "delete" | "wire" | "deny") => void;
  onSelectPart?: (partId: string | null) => void;
}

export class Builder {
  tool: Tool = "place";
  placeDefId: string | null = null;
  rot: 0 | 1 | 2 | 3 = 0;
  ghost: { x: number; y: number; valid: boolean } | null = null;
  selected: string | null = null;
  multiSelection: Set<string> = new Set();
  wireFrom: { part: string; port: number } | null = null;
  clipboard: PlacedPart[] | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  wireHover: { part: string; port: number } | null = null;

  constructor(public bp: Blueprint, public events: BuilderEvents = {}) {}

  // ---------- transactions ----------

  private pushUndo() {
    this.undoStack.push(JSON.stringify({ parts: this.bp.parts, wires: this.bp.wires, logic: this.bp.logic }));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify({ parts: this.bp.parts, wires: this.bp.wires, logic: this.bp.logic }));
    const st = JSON.parse(s);
    this.bp.parts = st.parts;
    this.bp.wires = st.wires;
    this.bp.logic = st.logic;
    this.events.onChange?.();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify({ parts: this.bp.parts, wires: this.bp.wires, logic: this.bp.logic }));
    const st = JSON.parse(s);
    this.bp.parts = st.parts;
    this.bp.wires = st.wires;
    this.bp.logic = st.logic;
    this.events.onChange?.();
  }

  // ---------- placement ----------

  canPlaceAt(defId: string, x: number, y: number, rot: 0 | 1 | 2 | 3): boolean {
    const d = part(defId);
    const r = rot === 1 || rot === 3 ? { x, y, w: d.h, h: d.w } : { x, y, w: d.w, h: d.h };
    for (const p of this.bp.parts) {
      if (rectsOverlap(r, rectOf(p))) return false;
    }
    return true;
  }

  place(defId: string, x: number, y: number, rot: 0 | 1 | 2 | 3) {
    if (!this.canPlaceAt(defId, x, y, rot)) {
      this.events.onAction?.("deny");
      this.events.onMessage?.("Position occupied");
      return null;
    }
    this.pushUndo();
    const p: PlacedPart = { id: uid("p"), def: defId, x, y, rot };
    this.bp.parts.push(p);
    this.events.onAction?.("place");
    this.events.onChange?.();
    return p;
  }

  deleteSelected() {
    const ids = this.multiSelection.size > 0 ? [...this.multiSelection] : this.selected ? [this.selected] : [];
    if (!ids.length) return;
    this.pushUndo();
    this.bp.parts = this.bp.parts.filter((p) => !ids.includes(p.id));
    this.bp.wires = this.bp.wires.filter((w) => !ids.includes(w.a.part) && !ids.includes(w.b.part));
    this.bp.logic = this.bp.logic.filter((n) => !ids.some((id) => Object.values(n.params).includes(id)));
    if (this.selected && ids.includes(this.selected)) this.selected = null;
    this.multiSelection.clear();
    this.events.onAction?.("delete");
    this.events.onChange?.();
  }

  rotateSelected() {
    if (!this.selected) return;
    this.pushUndo();
    const p = this.bp.parts.find((q) => q.id === this.selected)!;
    p.rot = ((p.rot + 1) % 4) as 0 | 1 | 2 | 3;
    this.events.onChange?.();
  }

  copySelection() {
    const ids = this.multiSelection.size > 0 ? [...this.multiSelection] : this.selected ? [this.selected] : [];
    if (!ids.length) return;
    this.clipboard = this.bp.parts.filter((p) => ids.includes(p.id)).map((p) => ({ ...p }));
    this.events.onMessage?.(`Copied ${this.clipboard.length} part(s)`);
  }

  pasteAt(x: number, y: number) {
    if (!this.clipboard?.length) return;
    this.pushUndo();
    // paste relative to clipboard bounding box top-left
    let minX = Infinity, minY = Infinity;
    for (const p of this.clipboard) {
      const r = partRect(p);
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    }
    const dx = x - minX;
    const dy = y - minY;
    const newIds: string[] = [];
    for (const p of this.clipboard) {
      const np: PlacedPart = { ...p, id: uid("p"), x: p.x + dx, y: p.y + dy };
      if (!this.canPlaceAt(np.def, np.x, np.y, np.rot)) continue;
      this.bp.parts.push(np);
      newIds.push(np.id);
    }
    this.multiSelection = new Set(newIds);
    this.events.onChange?.();
  }

  // ---------- wires ----------

  wireStart(partId: string, portIdx: number) {
    this.wireFrom = { part: partId, port: portIdx };
    this.events.onMessage?.("WIRE: now click the destination port (ESC cancels)");
  }

  wireComplete(partId: string, portIdx: number) {
    if (!this.wireFrom) return;
    if (this.wireFrom.part === partId && this.wireFrom.port === portIdx) {
      this.wireFrom = null;
      return;
    }
    const dupe = this.bp.wires.some(
      (w) =>
        (w.a.part === this.wireFrom!.part && w.a.port === this.wireFrom!.port && w.b.part === partId && w.b.port === portIdx) ||
        (w.b.part === this.wireFrom!.part && w.b.port === this.wireFrom!.port && w.a.part === partId && w.a.port === portIdx),
    );
    if (dupe) {
      this.events.onMessage?.("Wire already exists");
      this.wireFrom = null;
      return;
    }
    this.pushUndo();
    const w: Wire = { id: uid("w"), a: this.wireFrom, b: { part: partId, port: portIdx } };
    this.bp.wires.push(w);
    this.wireFrom = null;
    this.events.onAction?.("wire");
    this.events.onChange?.();
  }

  /** find the port (part, index) nearest a grid position, within snapping radius */
  findPort(gx: number, gy: number, radiusCells = 0.6): { part: string; port: number } | null {
    let best: { part: string; port: number } | null = null;
    let bestDist = radiusCells;
    for (const p of this.bp.parts) {
      const d = part(p.def);
      for (let i = 0; i < d.ports.length; i++) {
        const pos = portWorldPos(this.bp, p.id, i);
        if (!pos) continue;
        const dist = Math.hypot(pos.x - gx, pos.y - gy);
        if (dist < bestDist) {
          bestDist = dist;
          best = { part: p.id, port: i };
        }
      }
    }
    return best;
  }

  // ---------- helpers for panels ----------

  stats() {
    return robotStats(this.bp);
  }
}

export { CELL, computeAdjacency };
