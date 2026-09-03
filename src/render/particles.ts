// SCRAP AND STEEL — render/particles.ts
// Pooled particle system: sparks on impacts, smoke from damaged parts,
// explosion bursts on destruction. One Points mesh; zero per-frame allocation
// in steady state.

import * as THREE from "three";

interface P {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  kind: 0 | 1 | 2; // 0 spark, 1 smoke, 2 ember
}

const MAX = 900;

export class Particles {
  points: THREE.Points;
  private pool: P[] = [];
  private geom: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    this.geom = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX * 3);
    this.colors = new Float32Array(MAX * 3);
    this.sizes = new Float32Array(MAX);
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geom.setAttribute("size", new THREE.BufferAttribute(this.sizes, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {},
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (180.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.1, length(d));
          gl_FragColor = vec4(vColor, a);
        }
      `,
    });
    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < MAX; i++) {
      this.pool.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 1,
        kind: 0,
      });
    }
  }

  private spawn(kind: 0 | 1 | 2, pos: { x: number; y: number; z: number }, vel: THREE.Vector3, life: number, size: number) {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % MAX;
    p.alive = true;
    p.kind = kind;
    p.pos.set(pos.x, pos.y, pos.z);
    p.vel.copy(vel);
    p.life = life;
    p.maxLife = life;
    p.size = size;
  }

  sparks(pos: { x: number; y: number; z: number }, count: number, power: number) {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 6 * power,
        Math.random() * 5 * power + 1,
        (Math.random() - 0.5) * 6 * power,
      );
      this.spawn(0, pos, v, 0.3 + Math.random() * 0.5, 0.5 + power * 0.5);
    }
    // ember flash
    this.spawn(2, pos, new THREE.Vector3(0, 0.5, 0), 0.12, 6 + power * 8);
  }

  smoke(pos: { x: number; y: number; z: number }, count: number) {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5);
      this.spawn(1, pos, v, 1.2 + Math.random() * 1.2, 3 + Math.random() * 4);
    }
  }

  explosion(pos: { x: number; y: number; z: number }) {
    this.sparks(pos, 40, 1.8);
    for (let i = 0; i < 14; i++) {
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 2.2,
        1 + Math.random() * 2,
        (Math.random() - 0.5) * 2.2,
      );
      this.spawn(1, pos, v, 1.5 + Math.random(), 5 + Math.random() * 7);
    }
  }

  update(dt: number) {
    const sparksColor = new THREE.Color(1.0, 0.72, 0.25);
    const smokeColor = new THREE.Color(0.22, 0.2, 0.18);
    const emberColor = new THREE.Color(1.0, 0.5, 0.15);
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[i]!;
      if (!p.alive) {
        this.sizes[i] = 0;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.sizes[i] = 0;
        continue;
      }
      const frac = p.life / p.maxLife;
      // integrate
      if (p.kind === 0) {
        p.vel.y -= 9.8 * dt;
        p.vel.multiplyScalar(1 - 1.5 * dt);
      } else if (p.kind === 1) {
        p.vel.y += 0.6 * dt;
        p.vel.multiplyScalar(1 - 0.8 * dt);
      }
      p.pos.addScaledVector(p.vel, dt);
      this.positions[i * 3] = p.pos.x;
      this.positions[i * 3 + 1] = p.pos.y;
      this.positions[i * 3 + 2] = p.pos.z;
      const c = p.kind === 0 ? sparksColor : p.kind === 1 ? smokeColor : emberColor;
      const fade = p.kind === 1 ? 0.35 * frac : frac;
      this.colors[i * 3] = c.r * fade;
      this.colors[i * 3 + 1] = c.g * fade;
      this.colors[i * 3 + 2] = c.b * fade;
      this.sizes[i] = p.size * (p.kind === 1 ? 1 + (1 - frac) * 1.6 : frac);
    }
    this.geom.attributes.position!.needsUpdate = true;
    this.geom.attributes.color!.needsUpdate = true;
    this.geom.attributes.size!.needsUpdate = true;
  }

  clear() {
    for (const p of this.pool) p.alive = false;
  }
}
