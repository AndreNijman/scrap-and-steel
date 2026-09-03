// SCRAP AND STEEL — render/scene.ts
// Three.js scene management. Kept OUTSIDE any UI re-render cycle. Simulation owns
// state; renderer only reads it each animation frame.

import * as THREE from "three";
import type { MatchSimulation } from "../sim/simulation";
import type { RobotRuntime, PartRuntime } from "../sim/robot";
import type { ArenaDef } from "../content/parts";
import { CELL } from "../blueprint/types";

export type QualityTier = "low" | "medium" | "high";

const CATEGORY_COLORS: Record<string, number> = {
  frame: 0x8a8f98,
  armor: 0xb0b6bf,
  power: 0x3f8f4f,
  control: 0xc9a13b,
  drive: 0x4f6f9f,
  weapon: 0xa34434,
  cooling: 0x55aa99,
};

function partColor(p: PartRuntime, side: 0 | 1): number {
  const base = CATEGORY_COLORS[p.def.category] ?? 0x999999;
  const c = new THREE.Color(base);
  if (side === 1) c.offsetHSL(0, 0.05, 0.12); // slight tint to distinguish sides
  return c.getHex();
}

function makePartMesh(p: PartRuntime): THREE.Mesh {
  const s = p.def.size;
  let geo: THREE.BufferGeometry;
  switch (p.def.shape) {
    case "wheel": {
      const r = Math.max(s[0], s[2]) * CELL * 0.5 + 0.06; // match sim wheel radius
      geo = new THREE.CylinderGeometry(r, r, s[1] * CELL, 20);
      geo.rotateZ(Math.PI / 2); // axle along x
      break;
    }
    case "spinner_drum":
      geo = new THREE.CylinderGeometry(s[1] * CELL * 0.5, s[1] * CELL * 0.5, s[2] * CELL, 18);
      geo.rotateZ(Math.PI / 2);
      break;
    case "saw":
      geo = new THREE.CylinderGeometry(s[0] * CELL * 0.48, s[0] * CELL * 0.48, s[1] * CELL * 0.4, 24);
      geo.rotateY(Math.PI / 2);
      break;
    case "wedge":
      geo = wedgeGeometry(s[0] * CELL * 0.5, s[1] * CELL * 0.5, s[2] * CELL * 0.5);
      break;
    default:
      geo = new THREE.BoxGeometry(s[0] * CELL, s[1] * CELL, s[2] * CELL);
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.75, metalness: 0.35 });
  return new THREE.Mesh(geo, mat);
}

function wedgeGeometry(hx: number, hy: number, hz: number): THREE.BufferGeometry {
  // prism: slope rising toward -z (matches physics wedgePoints)
  const v = new Float32Array([
    // bottom
    -hx, -hy, hz, hx, -hy, hz, hx, -hy, -hz,
    -hx, -hy, hz, hx, -hy, -hz, -hx, -hy, -hz,
    // slope
    -hx, -hy, hz, -hx, hy, -hz, hx, hy, -hz,
    -hx, -hy, hz, hx, hy, -hz, hx, -hy, hz,
    // back face
    hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz,
    hx, -hy, -hz, -hx, hy, -hz, -hx, -hy, -hz,
    // sides
    -hx, -hy, hz, -hx, -hy, -hz, -hx, hy, -hz,
    hx, -hy, hz, hx, hy, -hz, hx, -hy, -hz,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

interface RobotRenderState {
  group: THREE.Group;
  meshes: Map<string, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; base: THREE.Color }>;
  wires: THREE.LineSegments;
}

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private robotStates: (RobotRenderState | null)[] = [null, null];
  private arenaGroup = new THREE.Group();
  private dirLight: THREE.DirectionalLight;
  quality: QualityTier = "medium";

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.scene.background = new THREE.Color(0x14100d);
    this.scene.fog = new THREE.Fog(0x14100d, 34, 85);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(8, 7, 10);
    this.camera.lookAt(0, 0.5, 0);

    const hemi = new THREE.HemisphereLight(0xfff2e0, 0x3d2c1f, 1.15);
    this.scene.add(hemi);
    this.dirLight = new THREE.DirectionalLight(0xffe8c8, 2.0);
    this.dirLight.position.set(8, 14, 6);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.left = -14;
    this.dirLight.shadow.camera.right = 14;
    this.dirLight.shadow.camera.top = 14;
    this.dirLight.shadow.camera.bottom = -14;
    this.scene.add(this.dirLight);
    // warm corner fill lights for a lit-arena feel
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
      const p = new THREE.PointLight(0xff9a4a, 12, 26, 1.8);
      p.position.set(x * 7.5, 4.5, z * 7.5);
      this.scene.add(p);
    }
    this.scene.add(this.arenaGroup);
  }

  private shake = 0;

  addShake(mag: number) {
    this.shake = Math.min(0.5, this.shake + mag);
  }

  setQuality(q: QualityTier) {
    this.quality = q;
    this.renderer.shadowMap.enabled = q !== "low";
    this.renderer.shadowMap.type = q === "high" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.dirLight.castShadow = q !== "low";
    this.dirLight.shadow.mapSize.set(q === "high" ? 2048 : 1024, q === "high" ? 2048 : 1024);
  }

  buildArena(arena: ArenaDef) {
    this.arenaGroup.clear();
    const h = arena.half;
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a3b30, roughness: 0.95 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(h * 2 + 2, 1, h * 2 + 2), floorMat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    this.arenaGroup.add(floor);

    // painted center ring + lane markings (procedural canvas texture)
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 512;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#4a3b30";
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = "#5d4a3a";
    g.lineWidth = 3;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.arc(256, 256, i * 30, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = "#8a5c30";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(256, 256, 120, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(256, 20);
    g.lineTo(256, 492);
    g.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const center = new THREE.Mesh(
      new THREE.PlaneGeometry(h * 1.4, h * 1.4),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, transparent: true, opacity: 0.55 }),
    );
    center.rotation.x = -Math.PI / 2;
    center.position.y = 0.012;
    center.receiveShadow = true;
    this.arenaGroup.add(center);

    // floor grid lines
    const grid = new THREE.GridHelper(h * 2, h * 4, 0x5a4636, 0x554433);
    grid.position.y = 0.011;
    this.arenaGroup.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.8, metalness: 0.2 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.6, emissive: 0x6a3510, emissiveIntensity: 0.35 });
    const wh = arena.wallH;
    const walls: [number, number, number, number, number, number][] = [
      [0, wh / 2, h + 0.25, h * 2 + 2, wh, 0.5],
      [0, wh / 2, -h - 0.25, h * 2 + 2, wh, 0.5],
      [h + 0.25, wh / 2, 0, 0.5, wh, h * 2 + 2],
      [-h - 0.25, wh / 2, 0, 0.5, wh, h * 2 + 2],
    ];
    for (const [x, y, z, sx, sy, sz] of walls) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.arenaGroup.add(m);
      // glowing trim strip along the top of each wall
      const trim = new THREE.Mesh(new THREE.BoxGeometry(sx > sz ? sx : sz * 0.15, 0.09, sz > sx ? sz : sx * 0.15), trimMat);
      trim.position.set(x * 0.985, y + sy / 2, z * 0.985);
      this.arenaGroup.add(trim);
    }
    // corner pylons
    const pyMat = new THREE.MeshStandardMaterial({ color: 0x3d3125, roughness: 0.7, metalness: 0.4 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, wh + 1.4, 0.7), pyMat);
        p.position.set(sx * (h + 0.25), (wh + 1.4) / 2, sz * (h + 0.25));
        p.castShadow = true;
        this.arenaGroup.add(p);
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.18, 0.5),
          new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb45e, emissiveIntensity: 1.6 }),
        );
        lamp.position.set(sx * (h + 0.25), wh + 1.2, sz * (h + 0.25));
        this.arenaGroup.add(lamp);
      }
    }
    if (arena.ramps) {
      const rampMat = new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.85 });
      for (const sx of [-1, 1]) {
        const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.24, 4.8), rampMat);
        ramp.position.set(sx * (h - 2.2), 0.35, 0);
        ramp.rotation.z = (sx * Math.PI) / 12;
        ramp.castShadow = true;
        ramp.receiveShadow = true;
        this.arenaGroup.add(ramp);
      }
    }
  }

  /** Create meshes for both robots from their runtimes. */
  syncRobotMeshes(sim: MatchSimulation) {
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const rt = sim.robots[side];
      let st = this.robotStates[side];
      if (!st) {
        const group = new THREE.Group();
        const wires = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: side === 0 ? 0x66ff88 : 0xff8866, transparent: true, opacity: 0.5 }),
        );
        group.add(wires);
        this.scene.add(group);
        st = { group, meshes: new Map(), wires };
        this.robotStates[side] = st;
      }
      // add missing meshes
      for (const p of rt.parts.values()) {
        if (!st.meshes.has(p.partId)) {
          const mesh = makePartMesh(p);
          const base = new THREE.Color(partColor(p, side));
          (mesh.material as THREE.MeshStandardMaterial).color.copy(base);
          mesh.castShadow = this.quality !== "low";
          mesh.receiveShadow = true;
          st.group.add(mesh);
          st.meshes.set(p.partId, { mesh, mat: mesh.material as THREE.MeshStandardMaterial, base });
        }
      }
      // wire visuals: rebuild geometry occasionally
      if (sim.tick % 30 === 0) this.updateWireLines(rt, st);
    }
  }

  private updateWireLines(rt: RobotRuntime, st: RobotRenderState) {
    const positions: number[] = [];
    for (const w of rt.bp.wires) {
      const a = rt.parts.get(w.from);
      const b = rt.parts.get(w.to);
      if (!a || !b) continue;
      const ta = a.body.translation();
      const tb = b.body.translation();
      positions.push(ta.x, ta.y, ta.z, tb.x, tb.y, tb.z);
    }
    st.wires.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    st.wires.geometry = g;
  }

  /** Copy physics transforms to meshes + damage/heat tinting. */
  updateFromSim(sim: MatchSimulation) {
    for (let side = 0 as 0 | 1; side <= 1; side++) {
      const st = this.robotStates[side];
      if (!st) continue;
      const rt = sim.robots[side];
      for (const p of rt.parts.values()) {
        const m = st.meshes.get(p.partId);
        if (!m) continue;
        const t = p.body.translation();
        const r = p.body.rotation();
        m.mesh.position.set(t.x, t.y, t.z);
        m.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        // damage + heat tint
        const hpFrac = Math.max(0, p.hp / p.maxHp);
        const heat = Math.min(1, Math.max(0, (p.temp - 80) / 90));
        if (p.destroyed) {
          m.mat.color.setHex(0x222222);
          m.mat.roughness = 1;
        } else {
          m.mat.color.copy(m.base).multiplyScalar(0.45 + 0.55 * hpFrac);
          m.mat.emissive.setRGB(heat * 0.9, heat * 0.25, 0);
        }
      }
    }
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  renderFrame() {
    // camera shake: jitter around the current position, restore after render
    if (this.shake > 0.001) {
      const base = this.camera.position.clone();
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.renderer.render(this.scene, this.camera);
      this.camera.position.copy(base);
      this.shake *= 0.86;
    } else {
      this.shake = 0;
      this.renderer.render(this.scene, this.camera);
    }
  }

  clearRobots() {
    for (let i = 0; i < 2; i++) {
      const st = this.robotStates[i];
      if (st) {
        this.scene.remove(st.group);
        st.group.traverse((o: THREE.Object3D) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
      }
      this.robotStates[i] = null;
    }
  }

  dispose() {
    this.clearRobots();
    this.renderer.dispose();
  }
}

/** Minimal orbit camera controller (drag orbit, wheel zoom, right-drag pan). */
export class OrbitCam {
  autoRotate = false;
  private theta = Math.PI / 4;
  private phi = 0.9;
  private radius = 12;

  getRadius(): number { return this.radius; }
  setRadius(r: number) { this.radius = Math.max(3, Math.min(45, r)); this.update(); }
  setPhi(p: number) { this.phi = Math.max(0.15, Math.min(1.45, p)); this.update(); }
  private target = new THREE.Vector3(0, 0.8, 0);
  private dragging = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    dom.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointermove", this.onMove);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    this.update();
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = e.button === 2 ? 2 : 1;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onUp = () => {
    this.dragging = 0;
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging === 1) {
      this.theta -= dx * 0.006;
      this.phi = Math.max(0.15, Math.min(1.45, this.phi - dy * 0.006));
    } else {
      const panScale = this.radius * 0.0016;
      const fwd = new THREE.Vector3(Math.sin(this.theta), 0, Math.cos(this.theta));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      this.target.addScaledVector(right, dx * panScale);
      this.target.y = Math.max(0, this.target.y + dy * panScale);
    }
    this.update();
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius = Math.max(3, Math.min(40, this.radius * (1 + Math.sign(e.deltaY) * 0.1)));
    this.update();
  };

  setTarget(x: number, y: number, z: number) {
    this.target.set(x, y, z);
    this.update();
  }

  update(dt = 0) {
    if (this.autoRotate && !this.dragging) this.theta += dt * 0.06;
    const sp = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sp * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sp * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
  }
}
