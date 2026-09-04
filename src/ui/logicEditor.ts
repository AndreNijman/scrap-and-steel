// SCRAP & STEEL — ui/logicEditor.ts
// Bottom-strip node editor. Add nodes, drag them, connect output -> input by
// dragging between ports, set params. Compact but real.

import type { Blueprint, LogicNode } from "../game/blueprint";
import { uid } from "../game/blueprint";
import { NODE_DEFS, NODE_TYPES_BY_CAT, type NodeCategory } from "../game/logic";
import { part } from "../game/parts";

const NODE_W = 92;
const NODE_H = 34;
const PORT_R = 4;

interface DragState {
  kind: "node" | "wire" | "pan";
  nodeId?: string;
  fromPort?: { node: string; out: string };
  startX?: number;
  startY?: number;
  curX?: number;
  curY?: number;
  scrollX?: number;
  scrollY?: number;
}

export class LogicEditor {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  scrollX = 20;
  scrollY = 10;
  drag: DragState | null = null;
  selectedNode: string | null = null;
  visible = false;
  catFilter: NodeCategory | "all" = "all";

  constructor(public bp: Blueprint, private onChange: () => void, private onSelect: (nodeId: string | null) => void) {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d");
    this.ctx = ctx;
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  mount(host: HTMLElement) {
    host.appendChild(this.canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width > 0) {
      this.canvas.width = Math.floor(r.width);
      this.canvas.height = Math.floor(r.height);
    }
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: sx - r.left + this.scrollX, y: sy - r.top + this.scrollY };
  }

  nodeAt(x: number, y: number): LogicNode | null {
    for (let i = this.bp.logic.length - 1; i >= 0; i--) {
      const n = this.bp.logic[i]!;
      if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n;
    }
    return null;
  }

  portAt(x: number, y: number): { node: LogicNode; port: string; out: boolean } | null {
    for (const n of this.bp.logic) {
      const def = NODE_DEFS[n.type];
      if (!def) continue;
      // output port on the right edge, inputs on the left edge
      if (def.outputs.length && Math.abs(x - (n.x + NODE_W)) < 7 && Math.abs(y - (n.y + NODE_H / 2)) < 7) {
        return { node: n, port: def.outputs[0]!, out: true };
      }
      for (let i = 0; i < def.inputs.length; i++) {
        const py = n.y + 8 + ((i + 0.5) * (NODE_H - 12)) / Math.max(def.inputs.length, 1);
        if (Math.abs(x - n.x) < 7 && Math.abs(y - py) < 7) {
          return { node: n, port: def.inputs[i]!, out: false };
        }
      }
    }
    return null;
  }

  addNode(type: string, x?: number, y?: number) {
    const def = NODE_DEFS[type];
    if (!def) return;
    const n: LogicNode = {
      id: uid("n"),
      type,
      x: x ?? this.scrollX + 60 + Math.random() * 80,
      y: y ?? this.scrollY + 30 + Math.random() * 60,
      params: {},
      in: {},
    };
    for (const key of def.inputs) n.in[key] = null;
    for (const p of def.params ?? []) {
      if (p.kind === "number") n.params[p.key] = 0;
      if (p.kind === "select" || p.kind === "target") n.params[p.key] = "";
    }
    this.bp.logic.push(n);
    this.selectedNode = n.id;
    this.onSelect(n.id);
    this.onChange();
  }

  deleteSelected() {
    if (!this.selectedNode) return;
    this.bp.logic = this.bp.logic.filter((n) => n.id !== this.selectedNode);
    for (const n of this.bp.logic) {
      for (const k of Object.keys(n.in)) if (n.in[k] === this.selectedNode) n.in[k] = null;
    }
    this.selectedNode = null;
    this.onSelect(null);
    this.onChange();
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const w = this.screenToWorld(e.clientX, e.clientY);
    const port = this.portAt(w.x, w.y);
    if (port) {
      if (port.out) {
        this.drag = { kind: "wire", fromPort: { node: port.node.id, out: port.port } };
      } else {
        // clicking an input port that has a connection: detach it (drag to move)
        const src = port.node.in[port.port];
        if (src) {
          port.node.in[port.port] = null;
          this.onChange();
          this.drag = { kind: "wire", fromPort: { node: src, out: "val" } };
        } else {
          this.drag = { kind: "wire", fromPort: { node: port.node.id, out: "!in:" + port.port } };
        }
      }
      return;
    }
    const n = this.nodeAt(w.x, w.y);
    if (n) {
      this.selectedNode = n.id;
      this.onSelect(n.id);
      this.drag = { kind: "node", nodeId: n.id, startX: w.x - n.x, startY: w.y - n.y };
    } else {
      this.selectedNode = null;
      this.onSelect(null);
      this.drag = { kind: "pan", startX: e.clientX, startY: e.clientY, scrollX: this.scrollX, scrollY: this.scrollY };
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const w = this.screenToWorld(e.clientX, e.clientY);
    if (this.drag.kind === "node" && this.drag.nodeId) {
      const n = this.bp.logic.find((q) => q.id === this.drag!.nodeId);
      if (n) {
        n.x = Math.max(0, w.x - (this.drag.startX ?? 0));
        n.y = Math.max(0, w.y - (this.drag.startY ?? 0));
        this.onChange();
      }
    } else if (this.drag.kind === "pan") {
      this.scrollX = (this.drag.scrollX ?? 0) - (e.clientX - (this.drag.startX ?? 0));
      this.scrollY = (this.drag.scrollY ?? 0) - (e.clientY - (this.drag.startY ?? 0));
    } else if (this.drag.kind === "wire") {
      this.drag.curX = w.x;
      this.drag.curY = w.y;
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag?.kind === "wire" && this.drag.fromPort) {
      const w = this.screenToWorld(e.clientX, e.clientY);
      const port = this.portAt(w.x, w.y);
      const from = this.drag.fromPort;
      if (port && from) {
        if (from.out.startsWith("!in:")) {
          // dragging FROM an input port: connect original source to this port
          const srcNode = from.node;
          if (port.out) {
            port.node.in[port.port] = srcNode;
            this.onChange();
          }
        } else if (port.out) {
          // out -> out: retarget the source node's consumers? ignore
        } else {
          port.node.in[port.port] = from.node;
          this.onChange();
        }
      }
    }
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.scrollY += e.deltaY * 0.5;
    this.scrollX += e.deltaX * 0.5;
  };

  render() {
    if (!this.visible) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = "#171b21";
    ctx.fillRect(0, 0, w, h);
    // grid
    ctx.strokeStyle = "rgba(70,90,110,0.12)";
    for (let x = -this.scrollX % 24; x < w; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = -this.scrollY % 24; y < h; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    ctx.save();
    ctx.translate(-this.scrollX, -this.scrollY);

    // connections
    for (const n of this.bp.logic) {
      const def = NODE_DEFS[n.type];
      if (!def) continue;
      for (let i = 0; i < def.inputs.length; i++) {
        const src = n.in[def.inputs[i]!];
        if (!src) continue;
        const srcNode = this.bp.logic.find((q) => q.id === src);
        if (!srcNode) continue;
        const x1 = srcNode.x + NODE_W;
        const y1 = srcNode.y + NODE_H / 2;
        const py = n.y + 8 + ((i + 0.5) * (NODE_H - 12)) / Math.max(def.inputs.length, 1);
        const x2 = n.x;
        const y2 = py;
        ctx.strokeStyle = wireHue(srcNode.type);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + 20, y1, x2 - 20, y2, x2, y2);
        ctx.stroke();
      }
    }

    // pending wire
    if (this.drag?.kind === "wire" && this.drag.fromPort) {
      const srcNode = this.bp.logic.find((q) => q.id === this.drag!.fromPort!.node);
      if (srcNode) {
        const x1 = srcNode.x + NODE_W;
        const y1 = srcNode.y + NODE_H / 2;
        ctx.strokeStyle = "#ffd866";
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo((this.drag.curX ?? 0), (this.drag.curY ?? 0));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // nodes
    for (const n of this.bp.logic) {
      const def = NODE_DEFS[n.type];
      if (!def) continue;
      const x = n.x;
      const y = n.y;
      const sel = n.id === this.selectedNode;
      ctx.fillStyle = def.cat === "input" ? "#23303c" : def.cat === "output" ? "#332723" : def.cat === "flow" ? "#2c2438" : "#232b26";
      ctx.fillRect(x, y, NODE_W, NODE_H);
      ctx.strokeStyle = sel ? "#ffd866" : def.cat === "input" ? "#3b7dd8" : def.cat === "output" ? "#d97a2e" : "#4a5560";
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, NODE_W - 1, NODE_H - 1);
      ctx.fillStyle = "#cfd6de";
      ctx.font = "8px 'IBM Plex Mono', monospace";
      const label = def.name.length > 14 ? def.name.slice(0, 13) + "…" : def.name;
      ctx.fillText(label, x + 10, y + NODE_H / 2 + 3);
      // ports
      for (let i = 0; i < def.inputs.length; i++) {
        const py = y + 8 + ((i + 0.5) * (NODE_H - 12)) / Math.max(def.inputs.length, 1);
        ctx.fillStyle = n.in[def.inputs[i]!] ? "#5fbf5f" : "#767f8c";
        ctx.beginPath();
        ctx.arc(x, py, PORT_R, 0, Math.PI * 2);
        ctx.fill();
      }
      if (def.outputs.length) {
        ctx.fillStyle = "#ffd866";
        ctx.beginPath();
        ctx.arc(x + NODE_W, y + NODE_H / 2, PORT_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    if (!this.bp.logic.length) {
      ctx.fillStyle = "#5a6470";
      ctx.font = "11px 'IBM Plex Mono', monospace";
      ctx.fillText("ADD LOGIC NODES — pick a category above, then click. Drag gold output ports onto input ports.", 12, h / 2);
    }
  }
}

function wireHue(type: string): string {
  if (type.startsWith("key_")) return "#3b7dd8";
  if (type === "sensor_value") return "#3ab8b8";
  if (type === "motor_power") return "#d97a2e";
  if (type === "weapon_fire") return "#b8433a";
  if (type === "servo_target") return "#d9a441";
  return "#4a9e4a";
}

/** populate target param dropdown options from the blueprint */
export function targetOptions(bp: Blueprint, kinds: string[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const p of bp.parts) {
    const d = part(p.def);
    let match = false;
    for (const k of kinds) {
      if (k === "motor" && d.motor) match = true;
      if (k === "servo" && (d.servo || d.piston || d.turret)) match = true;
      if (k === "sensor" && d.sensor) match = true;
      if (k === "weapon" && d.weapon && !d.barrel) match = true;
    }
    if (match) out.push({ id: p.id, label: `${d.name} (${p.id.slice(-4)})` });
  }
  return out;
}

export { NODE_TYPES_BY_CAT, NODE_DEFS };
