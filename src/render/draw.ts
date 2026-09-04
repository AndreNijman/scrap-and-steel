// SCRAP & STEEL — render/draw.ts
// Canvas 2D pixel renderer. Draws the arena, robots (sprites rotated per body),
// wires (colored looms with flow animation), particles, projectiles and overlays.

import planck from "planck-js";
import type { Simulation, RobotSide } from "../game/sim";
import type { Blueprint } from "../game/blueprint";
import { partRect } from "../game/blueprint";
import { part, CELL } from "../game/parts";
import { getSprite, isCircularSprite, C } from "./sprites";

export interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; maxLife: number;
  kind: "spark" | "smoke" | "flash" | "debris"; size: number; color: string;
}

export class WorldRenderer {
  particles: Particle[] = [];
  zoom = 42; // px per meter
  camX = 0;
  camY = 0;
  shake = 0;
  showPowerFlow = false;
  showHeat = false;
  time = 0;

  addParticle(kind: Particle["kind"], x: number, y: number, opts: Partial<Particle> = {}) {
    if (this.particles.length > 500) this.particles.shift();
    this.particles.push({
      x, y,
      vx: opts.vx ?? (Math.random() - 0.5) * 3,
      vy: opts.vy ?? Math.random() * 3,
      life: opts.life ?? 0.5,
      maxLife: opts.life ?? 0.5,
      kind,
      size: opts.size ?? 3,
      color: opts.color ?? "#ffce54",
    });
  }

  explosion(x: number, y: number, big: boolean) {
    const n = big ? 30 : 12;
    for (let i = 0; i < n; i++) {
      this.addParticle("spark", x, y, {
        vx: (Math.random() - 0.5) * (big ? 14 : 7),
        vy: Math.random() * (big ? 10 : 5),
        life: 0.3 + Math.random() * 0.5,
        size: big ? 5 : 3,
        color: Math.random() < 0.5 ? "#ffce54" : "#ff6b35",
      });
    }
    for (let i = 0; i < (big ? 12 : 5); i++) {
      this.addParticle("smoke", x, y, { vy: 1 + Math.random(), life: 1 + Math.random(), size: 6 + Math.random() * 6, color: "#555" });
    }
    this.addParticle("flash", x, y, { life: 0.12, size: big ? 60 : 30, color: "#fff" });
    this.shake = Math.min(14, this.shake + (big ? 10 : 4));
  }

  sparks(x: number, y: number, power: number) {
    for (let i = 0; i < Math.min(14, 3 + power / 8); i++) {
      this.addParticle("spark", x, y, {
        vx: (Math.random() - 0.5) * 8,
        vy: Math.random() * 5,
        life: 0.2 + Math.random() * 0.4,
        size: 2 + Math.random() * 2,
        color: Math.random() < 0.7 ? "#ffce54" : "#ffffff",
      });
    }
    this.shake = Math.min(10, this.shake + power / 60);
  }

  update(dt: number) {
    this.time += dt;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      if (p.kind === "spark" || p.kind === "debris") p.vy -= 9 * dt;
      if (p.kind === "smoke") { p.vy += 0.5 * dt; p.vx *= 0.98; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.shake *= 0.88;
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number, sim: Simulation | null, bpA: Blueprint | null, buildMode: boolean) {
    ctx.imageSmoothingEnabled = false;
    // sky
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const arena = sim?.arena;
    grad.addColorStop(0, arena?.sky[0] ?? "#232b33");
    grad.addColorStop(1, arena?.sky[1] ?? "#141a20");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const z = this.zoom;
    const shakeX = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0.2 ? (Math.random() - 0.5) * this.shake : 0;
    const camScreenX = w / 2 + shakeX;
    const camScreenY = h * 0.62 + shakeY;

    // world transform: meters -> pixels (y-up)
    const tx = (mx: number) => camScreenX + (mx - this.camX) * z;
    const ty = (my: number) => camScreenY - (my - this.camY) * z;

    // distant hills
    if (arena) {
      ctx.fillStyle = arena.hills;
      const hy = ty(0);
      ctx.fillRect(0, hy - 30, w, 30);
      ctx.fillStyle = "#0000";
    }

    if (buildMode && bpA) {
      // build view: y-DOWN, matching blueprint space (row 0 = top)
      const tyDown = (my: number) => camScreenY + (my - this.camY) * z;
      this.renderBuild(ctx, bpA, tx, tyDown, z);
    } else if (sim) {
      this.renderSim(ctx, sim, tx, ty, z, w, h);
    }

    // particles (world space)
    for (const p of this.particles) {
      const px = tx(p.x);
      const py = ty(p.y);
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = p.kind === "smoke" ? alpha * 0.35 : alpha;
      ctx.fillStyle = p.color;
      const s = p.kind === "smoke" ? p.size * (1 + (1 - alpha)) * (z / 42) : p.size;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  private renderBuild(ctx: CanvasRenderingContext2D, bp: Blueprint, tx: (m: number) => number, tyDown: (m: number) => number, z: number) {
    // ground line: one row below the lowest built part (blueprint y grows down)
    let maxRow = 2;
    for (const p of bp.parts) {
      const r = partRect(p);
      maxRow = Math.max(maxRow, r.y + r.h);
    }
    const gy = tyDown(maxRow * CELL);
    ctx.fillStyle = "#2a2620";
    ctx.fillRect(0, gy, ctx.canvas.width, ctx.canvas.height - gy);
    ctx.fillStyle = "#3a3428";
    ctx.fillRect(0, gy, ctx.canvas.width, 3);

    // grid
    const gridPx = CELL * z;
    if (gridPx > 8) {
      ctx.strokeStyle = "rgba(90, 110, 130, 0.16)";
      ctx.lineWidth = 1;
      const startX = tx(0) % gridPx;
      for (let x = startX; x < ctx.canvas.width; x += gridPx) {
        ctx.beginPath(); ctx.moveTo(Math.floor(x) + 0.5, 0); ctx.lineTo(Math.floor(x) + 0.5, ctx.canvas.height); ctx.stroke();
      }
      const startY = tyDown(0) % gridPx;
      for (let y = startY; y < ctx.canvas.height; y += gridPx) {
        ctx.beginPath(); ctx.moveTo(0, Math.floor(y) + 0.5); ctx.lineTo(ctx.canvas.width, Math.floor(y) + 0.5); ctx.stroke();
      }
      // ground axis highlight
      ctx.strokeStyle = "rgba(120, 160, 120, 0.3)";
      ctx.beginPath(); ctx.moveTo(0, Math.floor(gy) + 0.5); ctx.lineTo(ctx.canvas.width, Math.floor(gy) + 0.5); ctx.stroke();
    }

    // wires (blueprint port positions, y-down)
    this.renderWires(ctx, bp, (partId, portIdx) => {
      const pos = portPosMeters(bp, partId, portIdx);
      return pos ? { x: tx(pos.x), y: tyDown(pos.y) } : null;
    }, null, this.showPowerFlow);

    // parts
    for (const p of bp.parts) {
      this.drawPartStatic(ctx, p, tx, tyDown, z);
    }
  }

  /** Wire looms. toScreen resolves an endpoint to SCREEN px; net optional (flow/trip). */
  private renderWires(
    ctx: CanvasRenderingContext2D,
    bp: Blueprint,
    toScreen: (partId: string, portIdx: number) => { x: number; y: number } | null,
    sim: RobotSide | null,
    showFlow: boolean,
  ) {
    for (const wire of bp.wires) {
      const a = toScreen(wire.a.part, wire.a.port);
      const b = toScreen(wire.b.part, wire.b.port);
      if (!a || !b) continue;
      const rt = sim ? sim.net.wires.get(wire.id) : null;
      const color = rt?.tripped ? "#5a5a5a" : rt?.broken ? "#3a2020" : wireColor(bp, wire);
      const ax = a.x;
      const ay = a.y;
      const bx = b.x;
      const by = b.y;
      const midY = (ay + by) / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax, midY);
      ctx.lineTo(bx, midY);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (sim && showFlow && rt && !rt.tripped && !rt.broken && rt.amps > 0.3) {
        const t = (this.time * 2) % 1;
        ctx.fillStyle = "#ffe8a0";
        for (const [x1, y1, x2, y2] of [[ax, ay, ax, midY], [ax, midY, bx, midY], [bx, midY, bx, by]] as [number, number, number, number][]) {
          const dx = x2 - x1;
          const dy = y2 - y1;
          const px = x1 + dx * t;
          const py = y1 + dy * t;
          ctx.fillRect(px - 2, py - 2, 4, 4);
        }
      }
    }
  }

  private drawPartStatic(ctx: CanvasRenderingContext2D, p: import("../game/blueprint").PlacedPart, tx: (m: number) => number, ty: (m: number) => number, z: number, selected?: boolean, hover?: boolean, ghost?: { valid: boolean }) {
    const d = part(p.def);
    const r = partRect(p);
    const x = tx(r.x * CELL);
    const y = ty(r.y * CELL);
    const wPx = r.w * CELL * z;
    const hPx = r.h * CELL * z;
    const sprite = getSprite(p.def, d.w, d.h);
    ctx.save();
    ctx.translate(x, y);
    if (p.rot === 2) ctx.scale(-1, 1);
    if (p.rot === 1) { ctx.rotate(Math.PI / 2); ctx.translate(0, -wPx); }
    else if (p.rot === 3) { ctx.rotate(-Math.PI / 2); ctx.translate(-hPx, 0); }
    if (isCircularSprite(p.def)) {
      // circular sprites are drawn at their physics diameter
      const dia = (d.wheel ? d.wheel.radius * 2 : d.w * CELL) * z;
      ctx.drawImage(sprite, -dia / 2, -dia / 2, dia, dia);
    } else {
      ctx.drawImage(sprite, 0, 0, wPx, hPx);
    }
    ctx.restore();
    if (selected || hover) {
      ctx.strokeStyle = selected ? "#ffd866" : "rgba(120,200,255,0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, wPx + 4, hPx + 4);
    }
    if (ghost) {
      ctx.globalAlpha = 0.45;
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = ghost.valid ? "#5fbf5f" : "#c05038";
      ctx.fillRect(x, y, wPx, hPx);
      ctx.globalAlpha = 1;
    }
  }


  private renderSim(ctx: CanvasRenderingContext2D, sim: Simulation, tx: (m: number) => number, ty: (m: number) => number, z: number, w: number, h: number) {
    const arena = sim.arena;
    const gy = ty(0);
    // ground
    ctx.fillStyle = "#2a2620";
    ctx.fillRect(0, gy, w, h - gy);
    ctx.fillStyle = "#3a3428";
    ctx.fillRect(0, gy, w, 3);
    // grass/dirt speckles
    ctx.fillStyle = "#4a4436";
    for (let i = 0; i < 60; i++) {
      const sx = ((i * 137.5) % arena.width) * z + w / 2 - this.camX * z;
      if (sx < -10 || sx > w + 10) continue;
      ctx.fillRect(sx, gy + 6 + (i % 3) * 4, 3, 2);
    }

    // arena obstacles
    for (const ob of arena.obstacles) {
      const x = tx(ob.x);
      const y = ty(ob.y + ob.h);
      const wPx = ob.w * z;
      const hPx = ob.h * z;
      if (ob.kind === "crate") {
        ctx.fillStyle = "#6a5230";
        ctx.fillRect(x, y, wPx, hPx);
        ctx.strokeStyle = "#4a3820";
        ctx.strokeRect(x + 1, y + 1, wPx - 2, hPx - 2);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + wPx, y + hPx); ctx.moveTo(x + wPx, y); ctx.lineTo(x, y + hPx); ctx.stroke();
      } else if (ob.kind === "wall") {
        ctx.fillStyle = "#4a5058";
        ctx.fillRect(x, y, wPx, hPx);
        ctx.fillStyle = "#3a4048";
        for (let yy = y; yy < y + hPx; yy += 8) ctx.fillRect(x, yy, wPx, 1);
      } else if (ob.kind === "platform") {
        ctx.fillStyle = "#3e4650";
        ctx.fillRect(x, y, wPx, hPx);
        ctx.fillStyle = "#5a646e";
        ctx.fillRect(x, y, wPx, 3);
      } else if (ob.kind === "ramp") {
        ctx.fillStyle = "#5a4a30";
        ctx.beginPath();
        ctx.moveTo(x, y + hPx);
        ctx.lineTo(x + wPx, y + hPx);
        ctx.lineTo(x + wPx, y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // walls at edges
    ctx.fillStyle = "#3a4048";
    ctx.fillRect(tx(-1.5), ty(8), 1.5 * z, 8 * z);
    ctx.fillRect(tx(arena.width + 0.5), ty(8), 1.5 * z, 8 * z);

    // wires for both robots (live body positions)
    for (const side of sim.robots) {
      if (!side) continue;
      this.renderWires(ctx, side.bp, (partId, portIdx) => {
        const pb = side.phys.bodies.get(partId);
        const def = pb && !pb.destroyed ? pb.def : side.bp.parts.find((q) => q.id === partId) ? part(side.bp.parts.find((q) => q.id === partId)!.def) : null;
        if (pb && !pb.destroyed) {
          const pos = pb.body.getPosition();
          return { x: tx(pos.x), y: ty(pos.y) };
        }
        const pos = portPosMeters(side.bp, partId, portIdx);
        return pos ? { x: tx(pos.x), y: ty(pos.y) } : null;
        void def;
      }, side, this.showPowerFlow);
    }

    // robots
    for (const side of sim.robots) {
      if (!side) continue;
      const teamTint = side.index === 0 ? "rgba(90,160,255,0.12)" : "rgba(255,120,90,0.12)";
      for (const p of side.bp.parts) {
        const pb = side.phys.bodies.get(p.id);
        if (!pb || pb.destroyed) continue;
        const d = part(p.def);
        const pos = pb.body.getPosition();
        const ang = pb.body.getAngle();
        const sprite = getSprite(p.def, d.w, d.h);
        const x = tx(pos.x);
        const y = ty(pos.y);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-ang);
        if (isCircularSprite(p.def)) {
          const dia = (d.wheel ? d.wheel.radius * 2 : d.w * CELL) * z;
          ctx.drawImage(sprite, -dia / 2, -dia / 2, dia, dia);
          // spin marker rotation for discs
          if (d.weapon?.kind === "spinner") {
            ctx.rotate(pb.spinRate * this.time % (Math.PI * 2));
            ctx.fillStyle = "rgba(255,80,60,0.5)";
            ctx.fillRect(-dia / 2, -2, dia, 4);
          }
        } else {
          ctx.drawImage(sprite, -(d.w * CELL * z) / 2, -(d.h * CELL * z) / 2, d.w * CELL * z, d.h * CELL * z);
        }
        // damage tint
        const hpFrac = pb.hp / pb.maxHp;
        if (hpFrac < 0.6) {
          ctx.globalAlpha = (0.6 - hpFrac) * 0.9;
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(-(d.w * CELL * z) / 2, -(d.h * CELL * z) / 2, d.w * CELL * z, d.h * CELL * z);
          ctx.globalAlpha = 1;
        }
        // heat glow
        const temp = side.heat.get(p.id) ?? 20;
        if (temp > 80) {
          ctx.globalAlpha = Math.min(0.5, (temp - 80) / 100);
          ctx.fillStyle = "#ff5a2e";
          ctx.fillRect(-(d.w * CELL * z) / 2, -(d.h * CELL * z) / 2, d.w * CELL * z, d.h * CELL * z);
          ctx.globalAlpha = 1;
        }
        ctx.restore();
        // team tint silhouette (subtle) + smoke when very hot
        if (temp > 110 && Math.random() < 0.1) {
          this.addParticle("smoke", pos.x, pos.y + 0.2, { size: 5, life: 1, color: "#444" });
        }
        void teamTint;
      }
    }

    // projectiles
    for (const pr of sim.projectiles) {
      const p = pr.body.getPosition();
      const x = tx(p.x);
      const y = ty(p.y);
      ctx.fillStyle = pr.dmg > 50 ? "#9adfff" : "#ffd866";
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = "rgba(255,200,100,0.4)";
      ctx.fillRect(x - 6, y - 2, 6, 4);
    }
  }
}

function portPosMeters(bp: Blueprint, partId: string, portIdx: number): { x: number; y: number } | null {
  const p = bp.parts.find((q) => q.id === partId);
  if (!p) return null;
  const d = part(p.def);
  const port = d.ports[portIdx];
  if (!port) return null;
  const r = partRect(p);
  let lx: number;
  let ly: number;
  if (port.side === 0) { lx = 0; ly = port.off * d.h; }
  else if (port.side === 1) { lx = port.off * d.w; ly = 0; }
  else if (port.side === 2) { lx = d.w; ly = port.off * d.h; }
  else { lx = port.off * d.w; ly = d.h; }
  let rx = lx;
  let ry = ly;
  if (p.rot === 1) { const t = lx; rx = d.h - ly; ry = t; }
  else if (p.rot === 2) { rx = d.w - lx; ry = d.h - ly; }
  else if (p.rot === 3) { const t = lx; rx = ly; ry = d.w - t; }
  return { x: (r.x + rx) * CELL, y: (r.y + ry) * CELL };
}

function wireColor(bp: Blueprint, wire: import("../game/blueprint").Wire): string {
  // color by what's on the other end
  const aDef = part(bp.parts.find((p) => p.id === wire.a.part)?.def ?? "");
  if (aDef.weapon) return C.red;
  if (aDef.motor) return C.orange;
  if (aDef.sensor || aDef.cpu) return C.cyan;
  return C.yellow;
}

export { planck };
