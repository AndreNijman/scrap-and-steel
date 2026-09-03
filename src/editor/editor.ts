// SCRAP AND STEEL — editor/editor.ts
// Build Room editor: place/select/wire/delete/rotate with smart snap, transactional
// undo/redo, budget checks, preflight and autosave. Blueprint is the only source of
// truth; the editor mesh cache is rebuilt from it after every transaction.

import * as THREE from "three";
import type { Blueprint, PartInstance, InputChannel, WireGauge } from "../blueprint/types";
import { CELL, emptyBlueprint, cloneBlueprint, makeId, blueprintCost } from "../blueprint/types";
import { PART_DEFS, WIRE_COST, type PartDef } from "../content/parts";
import { blueprintHash } from "../blueprint/canonical";
import { analyzePowerGraph, type PreflightPowerIssue } from "../sim/power";

export type EditorTool = "place" | "select" | "wire";

export interface EditorStats {
  cost: number;
  mass: number;
  parts: number;
  wires: number;
  issues: PreflightPowerIssue[];
  hash: string;
}

export interface EditorCallbacks {
  onChange?: (bp: Blueprint, stats: EditorStats) => void;
  onSelect?: (partId: string | null) => void;
  onMessage?: (msg: string) => void;
}

const CATEGORY_COLORS: Record<string, number> = {
  frame: 0x8a8f98,
  armor: 0xb0b6bf,
  power: 0x3f8f4f,
  control: 0xc9a13b,
  drive: 0x4f6f9f,
  weapon: 0xa34434,
  cooling: 0x55aa99,
};

export class BuildEditor {
  bp: Blueprint;
  tool: EditorTool = "place";
  budgetSp = 1000;
  partLimit = 120;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private selected: string | null = null;
  private pendingWireFrom: string | null = null;
  private ghost: THREE.Mesh | null = null;
  private ghostDef: PartDef | null = null;
  private ghostPos: [number, number, number] = [0, 0, 0];
  private ghostRot = 0;
  private placeDefId: string | null = null;
  private meshes = new Map<string, THREE.Mesh>();
  private group = new THREE.Group();
  private wireGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private autosaveTimer: number | null = null;
  private saveKey = "scrap_bp_autosave_p1";

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private cb: EditorCallbacks = {},
    saveKey?: string,
  ) {
    this.bp = emptyBlueprint("My Robot");
    if (saveKey) this.saveKey = saveKey;
    scene.add(this.group);
    scene.add(this.wireGroup);
    scene.add(this.ghostGroup);
    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("keydown", this.onKey);
    this.loadAutosave();
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.wireGroup);
    this.scene.remove(this.ghostGroup);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("keydown", this.onKey);
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
  }

  // ---------- persistence ----------

  loadAutosave() {
    try {
      const raw = localStorage.getItem(this.saveKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schemaVersion === 1) this.bp = parsed;
      }
    } catch {
      // corrupted autosave: start fresh, never crash the editor
    }
    this.rebuild();
  }

  loadBlueprint(bp: Blueprint) {
    this.bp = cloneBlueprint(bp);
    this.undoStack = [];
    this.redoStack = [];
    this.rebuild();
  }

  getBlueprintSnapshot(): Blueprint {
    return cloneBlueprint(this.bp);
  }

  private scheduleAutosave() {
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(this.saveKey, JSON.stringify(this.bp));
      } catch {
        // storage full/blocked: non-fatal
      }
    }, 400);
  }

  // ---------- transactions ----------

  private pushUndo() {
    this.undoStack.push(JSON.stringify(this.bp));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.bp));
    this.bp = JSON.parse(s);
    this.emit();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.bp));
    this.bp = JSON.parse(s);
    this.emit();
  }

  private stats(): EditorStats {
    const { issues } = analyzePowerGraph(this.bp);
    return {
      cost: blueprintCost(this.bp),
      mass: this.bp.parts.reduce((s, p) => s + (PART_DEFS[p.defId]?.mass ?? 0), 0),
      parts: this.bp.parts.length,
      wires: this.bp.wires.length,
      issues,
      hash: blueprintHash(this.bp),
    };
  }

  private emit() {
    this.rebuild();
    this.cb.onChange?.(this.bp, this.stats());
    this.scheduleAutosave();
  }

  // ---------- editing operations ----------

  setTool(t: EditorTool) {
    this.tool = t;
    this.pendingWireFrom = null;
    this.clearGhost();
  }

  setPlaceDef(defId: string | null) {
    this.placeDefId = defId;
    this.tool = defId ? "place" : "select";
    this.clearGhost();
  }

  rotateGhost() {
    this.ghostRot = (this.ghostRot + 1) % 4;
    if (this.ghost) this.ghost.rotation.y = (this.ghostRot * Math.PI) / 2;
  }

  private canAfford(def: PartDef): boolean {
    const costNow = blueprintCost(this.bp);
    return costNow + def.cost <= this.budgetSp;
  }

  placePart() {
    if (!this.placeDefId) return;
    const def = PART_DEFS[this.placeDefId];
    if (!def) return;
    if (this.bp.parts.length >= this.partLimit) {
      this.cb.onMessage?.(`Part limit reached (${this.partLimit})`);
      return;
    }
    if (!this.canAfford(def)) {
      this.cb.onMessage?.(`Not enough Scrap Points (need ${def.cost})`);
      return;
    }
    this.pushUndo();
    const part: PartInstance = {
      id: makeId(),
      defId: def.id,
      pos: [...this.ghostPos] as [number, number, number],
      rot: this.ghostRot as 0 | 1 | 2 | 3,
    };
    this.bp.parts.push(part);
    this.autoBind(part.id, def);
    this.emit();
  }

  private autoBind(partId: string, def: PartDef) {
    const channels: InputChannel[] = def.motor
      ? ["throttle", "steer"]
      : def.weapon
        ? ["fire"]
        : def.lifter
          ? ["lift"]
          : [];
    for (const ch of channels) {
      // avoid duplicate weapon binds
      if (ch === "fire" && this.bp.bindings.some((b) => b.channel === "fire" && b.targetPartId !== partId)) continue;
      if (this.bp.bindings.some((b) => b.channel === ch && b.targetPartId === partId)) continue;
      this.bp.bindings.push({ channel: ch, targetPartId: partId });
    }
  }

  deletePart(partId: string) {
    this.pushUndo();
    this.bp.parts = this.bp.parts.filter((p) => p.id !== partId);
    this.bp.wires = this.bp.wires.filter((w) => w.from !== partId && w.to !== partId);
    this.bp.bindings = this.bp.bindings.filter((b) => b.targetPartId !== partId);
    if (this.selected === partId) this.selected = null;
    this.emit();
  }

  duplicateSelected() {
    if (!this.selected) return;
    const src = this.bp.parts.find((p) => p.id === this.selected);
    if (!src) return;
    const def = PART_DEFS[src.defId];
    if (!def) return;
    if (this.bp.parts.length >= this.partLimit || !this.canAfford(def)) {
      this.cb.onMessage?.("Cannot duplicate: limit or budget reached");
      return;
    }
    // find a free adjacent cell along +x
    for (let dx = 1; dx <= 6; dx++) {
      const cand: [number, number, number] = [src.pos[0] + dx, src.pos[1], src.pos[2]];
      if (!this.bp.parts.some((p) => p.pos[0] === cand[0] && p.pos[1] === cand[1] && p.pos[2] === cand[2])) {
        this.pushUndo();
        const copy: PartInstance = { id: makeId(), defId: src.defId, pos: cand, rot: src.rot };
        this.bp.parts.push(copy);
        this.autoBind(copy.id, def);
        // copy wires that were fully inside a duplicate? keep simple: rebind none
        this.emit();
        return;
      }
    }
    this.cb.onMessage?.("No free space next to part");
  }

  mirrorSelected() {
    if (!this.selected) return;
    const src = this.bp.parts.find((p) => p.id === this.selected);
    if (!src) return;
    const def = PART_DEFS[src.defId];
    if (!def) return;
    if (this.bp.parts.length >= this.partLimit || !this.canAfford(def)) return;
    const cand: [number, number, number] = [-src.pos[0], src.pos[1], src.pos[2]];
    if (this.bp.parts.some((p) => p.pos[0] === cand[0] && p.pos[1] === cand[1] && p.pos[2] === cand[2])) {
      this.cb.onMessage?.("Mirror position occupied");
      return;
    }
    this.pushUndo();
    const copy: PartInstance = {
      id: makeId(),
      defId: src.defId,
      pos: cand,
      rot: ((4 - src.rot) % 4) as 0 | 1 | 2 | 3,
    };
    this.bp.parts.push(copy);
    this.autoBind(copy.id, def);
    this.emit();
  }

  addWire(from: string, to: string, gauge: WireGauge = "medium") {
    if (from === to) return;
    if (this.bp.wires.some((w) => (w.from === from && w.to === to) || (w.from === to && w.to === from))) {
      this.cb.onMessage?.("Wire already exists");
      return;
    }
    const costNow = blueprintCost(this.bp);
    if (costNow + WIRE_COST > this.budgetSp) {
      this.cb.onMessage?.("Not enough Scrap Points for wire");
      return;
    }
    this.pushUndo();
    this.bp.wires.push({ id: makeId("w"), from, to, gauge });
    this.emit();
  }

  setBinding(partId: string, channel: InputChannel, on: boolean) {
    const existing = this.bp.bindings.find((b) => b.channel === channel && b.targetPartId === partId);
    if (on && !existing) {
      this.pushUndo();
      this.bp.bindings.push({ channel, targetPartId: partId });
      this.emit();
    } else if (!on && existing) {
      this.pushUndo();
      this.bp.bindings = this.bp.bindings.filter((b) => b !== existing);
      this.emit();
    }
  }

  // ---------- pointer interaction ----------

  private raycastGround(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    // intersect y = partMidY plane; approximate with y = 0.25 (first layer mid)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);
    const hit = new THREE.Vector3();
    if (!rc.ray.intersectPlane(plane, hit)) return null;
    return hit;
  }

  private raycastPart(e: PointerEvent): string | null {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hits = rc.intersectObjects([...this.group.children], false);
    for (const h of hits) {
      const id = (h.object.userData as { partId?: string }).partId;
      if (id) return id;
    }
    return null;
  }

  /** Smart snap: nearest free cell adjacent to an existing part, else ground grid snap. */
  private snapPos(world: THREE.Vector3): [number, number, number] {
    const cx = Math.round(world.x / CELL);
    const cz = Math.round(world.z / CELL);
    // find existing part near the hover point to snap against
    let best: [number, number, number] | null = null;
    let bestDist = Infinity;
    for (const p of this.bp.parts) {
      const dx = cx - p.pos[0];
      const dz = cz - p.pos[2];
      const d = Math.abs(dx) + Math.abs(dz);
      if (d >= 1 && d <= 2) {
        // adjacent candidates around that part
        const cands: [number, number, number][] = [
          [p.pos[0] + 1, p.pos[1], p.pos[2]],
          [p.pos[0] - 1, p.pos[1], p.pos[2]],
          [p.pos[0], p.pos[1], p.pos[2] + 1],
          [p.pos[0], p.pos[1], p.pos[2] - 1],
          [p.pos[0], p.pos[1] + 1, p.pos[2]],
        ];
        for (const c of cands) {
          const occupied = this.bp.parts.some((q) => q.pos[0] === c[0] && q.pos[1] === c[1] && q.pos[2] === c[2]);
          if (occupied) continue;
          const dist = Math.abs(cx - c[0]) + Math.abs(cz - c[2]);
          if (dist < bestDist) {
            bestDist = dist;
            best = c;
          }
        }
      }
    }
    const pos = best ?? [cx, 0, cz];
    return pos as [number, number, number];
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.tool !== "place" || !this.placeDefId) return;
    const hit = this.raycastGround(e);
    if (!hit) return;
    const snapped = this.snapPos(hit);
    this.ghostPos = snapped;
    const def = this.placeDefId ? PART_DEFS[this.placeDefId] : undefined;
    if (!def) return;
    if (!this.ghost || this.ghostDef !== def) {
      this.clearGhost();
      this.ghostDef = def;
      const geo = new THREE.BoxGeometry(def.size[0] * CELL, def.size[1] * CELL, def.size[2] * CELL);
      this.ghost = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: CATEGORY_COLORS[def.category] ?? 0xffffff, transparent: true, opacity: 0.45 }));
      this.ghostGroup.add(this.ghost);
    }
    this.ghost.position.set(snapped[0] * CELL, snapped[1] * CELL + (def.size[1] * CELL) / 2, snapped[2] * CELL);
    this.ghost.rotation.y = (this.ghostRot * Math.PI) / 2;
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // left click only; right/middle = camera
    const partId = this.raycastPart(e);
    if (this.tool === "place" && this.placeDefId) {
      this.placePart();
    } else if (this.tool === "select") {
      this.selected = partId;
      this.cb.onSelect?.(partId);
      this.rebuild();
    } else if (this.tool === "wire") {
      if (!partId) return;
      if (!this.pendingWireFrom) {
        this.pendingWireFrom = partId;
        this.cb.onMessage?.("Wire: now click the destination part");
      } else {
        // auto gauge: heavy for weapons, medium for motors, light otherwise
        const def = PART_DEFS[this.bp.parts.find((p) => p.id === partId)?.defId ?? ""];
        const gauge: WireGauge = def?.weapon ? "heavy" : def?.motor ? "medium" : "light";
        this.addWire(this.pendingWireFrom, partId, gauge);
        this.pendingWireFrom = null;
        this.cb.onMessage?.("Wire connected");
      }
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "r" || e.key === "R") this.rotateGhost();
    if (e.key === "Delete" || e.key === "x") {
      if (this.selected) this.deletePart(this.selected);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      this.undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
      e.preventDefault();
      this.redo();
    }
    if (e.key === "d" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.duplicateSelected();
    }
    if (e.key === "Escape") {
      this.setPlaceDef(null);
      this.pendingWireFrom = null;
    }
  };

  private clearGhost() {
    if (this.ghost) {
      this.ghostGroup.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghost = null;
      this.ghostDef = null;
    }
  }

  // ---------- mesh rebuild ----------

  private rebuild() {
    // dispose all and rebuild (cheap at <=120 parts, only on transactions)
    for (const m of this.meshes.values()) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.clear();
    for (const l of [...this.wireGroup.children]) this.wireGroup.remove(l);

    for (const p of this.bp.parts) {
      const def = PART_DEFS[p.defId];
      if (!def) continue;
      const geo = new THREE.BoxGeometry(def.size[0] * CELL, def.size[1] * CELL, def.size[2] * CELL);
      const mat = new THREE.MeshStandardMaterial({ color: CATEGORY_COLORS[def.category] ?? 0x999999, roughness: 0.75, metalness: 0.3 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.pos[0] * CELL, p.pos[1] * CELL + (def.size[1] * CELL) / 2, p.pos[2] * CELL);
      mesh.rotation.y = (p.rot * Math.PI) / 2;
      mesh.userData.partId = p.id;
      mesh.castShadow = true;
      if (p.id === this.selected) {
        mat.emissive = new THREE.Color(0x3355ff);
        mat.emissiveIntensity = 0.6;
      }
      this.group.add(mesh);
      this.meshes.set(p.id, mesh);
    }

    const linePos: number[] = [];
    for (const w of this.bp.wires) {
      const a = this.bp.parts.find((p) => p.id === w.from);
      const b = this.bp.parts.find((p) => p.id === w.to);
      if (!a || !b) continue;
      const da = PART_DEFS[a.defId];
      const db = PART_DEFS[b.defId];
      if (!da || !db) continue;
      linePos.push(
        a.pos[0] * CELL, a.pos[1] * CELL + (da.size[1] * CELL) / 2, a.pos[2] * CELL,
        b.pos[0] * CELL, b.pos[1] * CELL + (db.size[1] * CELL) / 2, b.pos[2] * CELL,
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd866 }));
    this.wireGroup.add(lines);
  }

  setSelected(partId: string | null) {
    this.selected = partId;
    this.rebuild();
  }
}
