// SCRAP & STEEL — render/sprites.ts
// Procedural pixel-art sprites. Each part is painted once into an offscreen
// canvas (16 px per grid cell) at load, then blitted by the world renderer.
// No image assets — everything is drawn pixel by pixel.

export const ART = 16; // pixels per cell

// industrial palette
export const C = {
  steelD: "#2b2f35",
  steel: "#3d434c",
  steelL: "#565e6a",
  steelH: "#767f8c",
  edge: "#15181c",
  bolt: "#8b939f",
  boltD: "#565e6a",
  rust: "#8a5a2e",
  copper: "#c47f3a",
  copperD: "#8a5a2e",
  yellow: "#d9a441",
  yellowD: "#8a6a2a",
  red: "#b8433a",
  redD: "#7a2a26",
  green: "#4a9e4a",
  greenD: "#2e6b2e",
  blue: "#3b7dd8",
  blueD: "#274f8a",
  purple: "#7a5ab8",
  orange: "#d97a2e",
  cream: "#c9c0a8",
  black: "#101318",
  white: "#cfd6de",
  pink: "#d86aa0",
  cyan: "#3ab8b8",
};

export class Painter {
  cv: HTMLCanvasElement | OffscreenCanvas;
  private g: CanvasRenderingContext2D;

  constructor(public wCells: number, public hCells: number) {
    const w = wCells * ART;
    const h = hCells * ART;
    if (typeof OffscreenCanvas !== "undefined") {
      this.cv = new OffscreenCanvas(w, h);
    } else {
      this.cv = document.createElement("canvas");
      this.cv.width = w;
      this.cv.height = h;
    }
    const ctx = (this.cv as HTMLCanvasElement).getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.g = ctx;
    this.g.imageSmoothingEnabled = false;
  }

  rect(x: number, y: number, w: number, h: number, color: string) {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, w, h);
  }

  px(x: number, y: number, color: string) {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, 1, 1);
  }

  /** hollow frame with 1px inner highlight/shadow bevel */
  bevel(x: number, y: number, w: number, h: number, base: string, light = C.steelH, dark = C.steelD) {
    this.rect(x, y, w, h, base);
    this.rect(x, y, w, 1, light);
    this.rect(x, y, 1, h, light);
    this.rect(x, y + h - 1, w, 1, dark);
    this.rect(x + w - 1, y, 1, h, dark);
  }

  bolt(x: number, y: number, color = C.bolt) {
    this.px(x, y, color);
    this.px(x + 1, y, C.boltD);
    this.px(x, y + 1, C.boltD);
    this.px(x + 1, y + 1, color);
  }

  bolts4(pad = 2) {
    const w = this.wCells * ART;
    const h = this.hCells * ART;
    this.bolt(pad, pad);
    this.bolt(w - pad - 2, pad);
    this.bolt(pad, h - pad - 2);
    this.bolt(w - pad - 2, h - pad - 2);
  }

  vents(x: number, y: number, w: number, h: number, n: number, color = C.steelD) {
    const step = Math.max(2, Math.floor(h / (n * 2)));
    for (let i = 0; i < n; i++) this.rect(x, y + i * step * 2, w, step, color);
  }

  /** random-ish scratches with a deterministic seed so sprites are stable */
  scratches(seed: number, n: number, color: string) {
    let s = seed;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const w = this.wCells * ART;
    const h = this.hCells * ART;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rnd() * (w - 3));
      const y = Math.floor(rnd() * (h - 2));
      const len = 1 + Math.floor(rnd() * 2);
      this.rect(x, y, len, 1, color);
    }
  }

  outline() {
    const w = this.wCells * ART;
    const h = this.hCells * ART;
    this.g.strokeStyle = C.edge;
    this.g.lineWidth = 1;
    this.g.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  toCanvas(): HTMLCanvasElement {
    if (this.cv instanceof HTMLCanvasElement) return this.cv;
    const c = document.createElement("canvas");
    c.width = this.wCells * ART;
    c.height = this.hCells * ART;
    const g = c.getContext("2d")!;
    g.drawImage(this.cv as OffscreenCanvas, 0, 0);
    return c;
  }
}

// ---------- generic painters ----------

function steelBox(p: Painter, base = C.steel) {
  p.bevel(0, 0, p.wCells * ART, p.hCells * ART, base);
  p.bolts4(2);
}

function circuit(p: Painter, boardColor = "#1e3a26", trace = C.green) {
  p.bevel(0, 0, p.wCells * ART, p.hCells * ART, C.steel);
  p.rect(2, 2, p.wCells * ART - 4, p.hCells * ART - 4, boardColor);
  // traces: l-shaped lines
  const w = p.wCells * ART;
  const h = p.hCells * ART;
  p.rect(4, 5, w - 9, 1, trace);
  p.rect(w - 6, 5, 1, h - 10, trace);
  p.rect(5, h - 7, 1, 3, trace);
  p.rect(5, h - 7, w - 12, 1, trace);
  // chips
  p.rect(w / 2 - 3, h / 2 - 3, 6, 6, C.black);
  p.px(w / 2 - 2, h / 2 - 2, C.steelH);
  p.rect(4, h / 2 - 2, 3, 2, C.yellow);
}

function battery(p: Painter, cellColor: string, cellCount: number, label: string) {
  p.bevel(0, 0, p.wCells * ART, p.hCells * ART, C.steel);
  const w = p.wCells * ART;
  const h = p.hCells * ART;
  const cw = Math.floor((w - 6) / cellCount) - 1;
  for (let i = 0; i < cellCount; i++) {
    const x = 3 + i * (cw + 1);
    p.bevel(x, 3, cw, h - 6, cellColor, C.white, C.black);
    p.rect(x, 3, cw, 2, C.steelH); // terminal strip
    p.px(x + 1, 2, C.bolt); // terminal nub
  }
  p.rect(3, h - 4, w - 6, 1, label === "HD" ? C.red : C.yellow);
  p.bolts4(1);
}

function motor(p: Painter, bodyColor: string, big: boolean) {
  const w = p.wCells * ART;
  const h = p.hCells * ART;
  p.bevel(0, 0, w, h, bodyColor);
  // cooling fins
  p.vents(2, 3, w - 4, h - 6, big ? 4 : 3, C.steelD);
  // shaft hub on right
  const hx = w - 4;
  p.rect(hx, h / 2 - 3, 4, 6, C.steelL);
  p.rect(w - 2, h / 2 - 2, 2, 4, C.bolt);
  // face plate + bolts
  p.rect(2, 2, 3, h - 4, C.steelL);
  p.bolts4(2);
  p.px(4, 4, C.red); // polarity dot
  if (big) p.rect(2, h - 4, 6, 2, C.yellowD);
}

function wheelSprite(radiusCells: number, style: "standard" | "racing" | "offroad" | "armored" | "omni" | "caster"): HTMLCanvasElement {
  const rPx = Math.round(radiusCells * 2 * ART); // diameter px
  const size = rPx + 2;
  const p = new Painter(size / ART, size / ART);
  const cx = size / 2;
  const cy = size / 2;
  const g = (p as unknown as { g: CanvasRenderingContext2D }).g;
  const rim = style === "racing" ? C.yellow : style === "armored" ? C.steelH : C.steel;
  const tire = style === "offroad" ? "#2e2a24" : C.black;
  g.fillStyle = tire;
  g.beginPath();
  g.arc(cx, cy, rPx / 2, 0, Math.PI * 2);
  g.fill();
  // tread
  g.fillStyle = style === "offroad" ? "#4a4438" : "#1a1e24";
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x1 = cx + Math.cos(ang) * (rPx / 2 - 1);
    const y1 = cy + Math.sin(ang) * (rPx / 2 - 1);
    g.fillRect(Math.floor(x1), Math.floor(y1), 2, 2);
  }
  // rim
  g.fillStyle = rim;
  g.beginPath();
  g.arc(cx, cy, rPx / 2 - 3, 0, Math.PI * 2);
  g.fill();
  // hub bolts
  g.fillStyle = C.steelD;
  for (let a = 0; a < 6; a++) {
    const ang = (a / 6) * Math.PI * 2;
    g.fillRect(Math.floor(cx + Math.cos(ang) * (rPx / 4) - 1), Math.floor(cy + Math.sin(ang) * (rPx / 4) - 1), 2, 2);
  }
  if (style === "omni") {
    g.fillStyle = C.cyan;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      g.fillRect(Math.floor(cx + Math.cos(ang) * (rPx / 2 - 3) - 1), Math.floor(cy + Math.sin(ang) * (rPx / 2 - 3) - 1), 3, 2);
    }
  }
  if (style === "armored") {
    g.fillStyle = C.steelD;
    g.fillRect(Math.floor(cx - rPx / 4), Math.floor(cy - 1), rPx / 2, 2);
  }
  g.strokeStyle = C.edge;
  g.beginPath();
  g.arc(cx, cy, rPx / 2, 0, Math.PI * 2);
  g.stroke();
  return p.toCanvas();
}

function triSprite(dir: "L" | "R", base: string, paint?: (p: Painter, g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const size = ART;
  const p = new Painter(1, 1);
  const g = (p as unknown as { g: CanvasRenderingContext2D }).g;
  g.fillStyle = base;
  g.beginPath();
  if (dir === "L") {
    g.moveTo(0.5, 0); g.lineTo(size, size); g.lineTo(0.5, size);
  } else {
    g.moveTo(size - 0.5, 0); g.lineTo(size - 0.5, size); g.lineTo(0, size);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = C.edge;
  g.stroke();
  paint?.(p, g);
  return p.toCanvas();
}

function barrelSprite(len: number): HTMLCanvasElement {
  const p = new Painter(len, 1);
  const w = len * ART;
  p.bevel(0, 3, w, 10, C.steel);
  p.rect(0, 5, w, 2, C.steelD);
  p.rect(0, 9, w, 2, C.steelD);
  // muzzle
  p.rect(w - 3, 2, 3, 12, C.steelL);
  p.rect(w - 2, 4, 2, 8, C.black);
  // mounting collar at breech end
  p.rect(0, 1, 4, 14, C.steelD);
  p.bolt(1, 2);
  p.bolt(1, 12);
  p.scratches(77, 5, C.rust);
  return p.toCanvas();
}

function trackSprite(): HTMLCanvasElement {
  const p = new Painter(2, 2);
  const w = 2 * ART;
  const h = 2 * ART;
  p.bevel(0, 0, w, h, C.steelD);
  // road wheels
  for (const [x, y] of [[7, 10], [16, 10], [25, 10]] as [number, number][]) {
    p.rect(x - 3, y - 3, 7, 7, C.steelL);
    p.rect(x - 1, y - 1, 3, 3, C.steelD);
  }
  // track band
  p.rect(1, h - 6, w - 2, 4, C.black);
  for (let x = 1; x < w - 2; x += 3) p.px(x, h - 5, "#3a4048");
  p.rect(1, 2, w - 2, 3, C.steel);
  p.bolts4(2);
  return p.toCanvas();
}

function discSprite(weapon: boolean): HTMLCanvasElement {
  const size = 2 * ART;
  const p = new Painter(2, 2);
  const g = (p as unknown as { g: CanvasRenderingContext2D }).g;
  const cx = size / 2;
  const cy = size / 2;
  g.fillStyle = weapon ? C.steelH : C.steelL;
  g.beginPath();
  g.arc(cx, cy, size / 2 - 1, 0, Math.PI * 2);
  g.fill();
  // teeth
  g.fillStyle = C.white;
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    g.fillRect(Math.floor(cx + Math.cos(ang) * (size / 2 - 2) - 1), Math.floor(cy + Math.sin(ang) * (size / 2 - 2) - 1), 3, 3);
  }
  g.fillStyle = C.black;
  g.beginPath();
  g.arc(cx, cy, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = C.red;
  g.fillRect(cx - 1, cy - 4, 2, 8); // spin marker
  g.strokeStyle = C.edge;
  g.beginPath();
  g.arc(cx, cy, size / 2 - 1, 0, Math.PI * 2);
  g.stroke();
  return p.toCanvas();
}

const spriteCache = new Map<string, HTMLCanvasElement>();

/** Paint the sprite for a part id. Returns a canvas (wCells*ART x hCells*ART). */
export function getSprite(partId: string, wCells: number, hCells: number): HTMLCanvasElement {
  const key = partId;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const p = new Painter(wCells, hCells);
  const w = wCells * ART;
  const h = hCells * ART;
  let cv: HTMLCanvasElement;

  switch (partId) {
    case "wheel_small": cv = wheelSprite(0.4, "standard"); break;
    case "wheel_medium": cv = wheelSprite(0.5, "standard"); break;
    case "wheel_large": cv = wheelSprite(0.8, "standard"); break;
    case "wheel_racing": cv = wheelSprite(0.52, "racing"); break;
    case "wheel_offroad": cv = wheelSprite(0.84, "offroad"); break;
    case "wheel_armored": cv = wheelSprite(0.8, "armored"); break;
    case "wheel_omni": cv = wheelSprite(0.5, "omni"); break;
    case "wheel_caster": cv = wheelSprite(0.32, "caster"); break;
    case "track_unit": cv = trackSprite(); break;
    case "tri_brace": cv = triSprite("L", C.steel); break;
    case "tri_brace_r": cv = triSprite("R", C.steel); break;
    case "arm_sloped": cv = triSprite("L", "#4a525c"); break;
    case "arm_sloped_r": cv = triSprite("R", "#4a525c"); break;
    case "spinner_disc": case "spinner_disc_w": cv = discSprite(partId === "spinner_disc_w"); break;
    case "gun_barrel_s": cv = barrelSprite(2); break;
    case "gun_barrel_l": cv = barrelSprite(3); break;
    default: {
      // category-specific defaults
      if (partId.startsWith("battery")) {
        battery(p, C.green, partId === "battery_small" ? 2 : partId === "battery_pack" ? 4 : 3, partId === "battery_hd" ? "HD" : "P");
        cv = p.toCanvas();
      } else if (partId.startsWith("motor_")) {
        motor(p, partId === "motor_industrial" ? C.rust : C.orange, partId === "motor_industrial");
        cv = p.toCanvas();
      } else if (partId === "micro_controller" || partId === "logic_processor" || partId === "advanced_cpu" || partId === "sensor_hub" || partId === "radio") {
        circuit(p, partId === "advanced_cpu" ? "#1e2a3e" : "#1e3a26", partId === "advanced_cpu" ? C.cyan : C.green);
        cv = p.toCanvas();
      } else if (partId.startsWith("sen_") || partId === "camera") {
        steelBox(p, C.steel);
        p.rect(3, 3, w - 6, 4, C.black); // lens band
        p.px(w - 5, 4, C.red); // indicator
        p.rect(3, 9, w - 6, 2, C.blueD);
        cv = p.toCanvas();
      } else if (partId.startsWith("arm_")) {
        p.bevel(0, 0, w, h, "#4a525c");
        p.scratches(31, 7, "#3a4148");
        p.scratches(97, 3, C.rust);
        p.bolts4(2);
        if (partId === "arm_composite") p.rect(2, 2, w - 4, 2, C.cream);
        if (partId === "arm_reactive") { p.rect(2, h / 2 - 2, w - 4, 4, C.redD); p.rect(2, h / 2 - 2, w - 4, 1, C.red); }
        if (partId === "arm_ceramic") p.rect(2, 2, w - 4, h - 4, "#8a8578");
        if (partId === "arm_heat") p.rect(2, 2, w - 4, 3, C.copper);
        cv = p.toCanvas();
      } else if (partId === "generator" || partId === "generator_big") {
        p.bevel(0, 0, w, h, C.rust);
        p.vents(3, 4, w - 6, h - 8, 4, C.black);
        p.rect(w / 2 - 4, h - 6, 8, 3, C.yellow); // warning stripe
        p.bolts4(2);
        cv = p.toCanvas();
      } else if (partId === "solar_panel") {
        p.bevel(0, 0, w, h, C.blueD);
        for (let i = 0; i < 4; i++) p.rect(2 + i * ((w - 4) / 4), 2, (w - 4) / 4 - 1, h - 4, C.blue);
        p.rect(2, h / 2, w - 4, 1, C.blueD);
        cv = p.toCanvas();
      } else if (partId === "fuse" || partId === "breaker" || partId === "switch" || partId === "relay") {
        steelBox(p, C.steelL);
        p.rect(3, 4, w - 6, h - 8, partId === "fuse" ? C.yellow : partId === "breaker" ? C.red : C.steelD);
        if (partId === "switch") p.rect(w / 2 - 1, 3, 2, h - 6, C.white);
        cv = p.toCanvas();
      } else if (partId === "dist_board" || partId === "bus_bar" || partId === "junction_box") {
        steelBox(p, C.steelL);
        p.rect(3, 3, w - 6, h - 6, C.copperD);
        p.rect(4, 4, w - 8, h - 8, C.copper);
        cv = p.toCanvas();
      } else if (partId === "capacitor") {
        steelBox(p, C.steel);
        p.rect(3, 3, w - 6, 4, C.purple);
        p.rect(3, h - 7, w - 6, 4, C.purple);
        cv = p.toCanvas();
      } else if (partId.startsWith("gun_") || partId === "rotary_cannon" || partId === "railgun" || partId === "arc_emitter" || partId === "missile_pod") {
        steelBox(p, C.steelD);
        p.rect(2, 2, w - 4, h - 4, "#4a3b30");
        p.rect(3, 3, w - 6, 3, C.steelH);
        p.bolts4(2);
        if (partId === "railgun") { p.rect(4, h / 2 - 1, w - 8, 1, C.cyan); p.rect(4, h / 2 + 1, w - 8, 1, C.cyan); }
        if (partId === "rotary_cannon") { for (let i = 0; i < 3; i++) p.rect(w - 6, 4 + i * 4, 5, 2, C.steelL); }
        if (partId === "missile_pod") { for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) p.rect(4 + j * 6, 4 + i * 6, 5, 5, C.redD); }
        if (partId === "arc_emitter") { p.rect(w - 4, h / 2 - 2, 3, 4, C.cyan); }
        cv = p.toCanvas();
      } else if (partId === "ammo_box") {
        p.bevel(0, 0, w, h, "#4e5a3a");
        p.rect(2, 2, w - 4, h - 4, "#5e6a46");
        p.rect(3, h / 2 - 1, w - 6, 2, C.yellow);
        p.scratches(11, 4, "#3a4430");
        cv = p.toCanvas();
      } else if (partId.startsWith("hyd_") || partId === "pneumatic_piston" || partId === "compressor" || partId === "air_tank" || partId === "linear_actuator" || partId === "servo") {
        steelBox(p, C.steel);
        p.rect(2, h / 2 - 2, w - 4, 4, partId.startsWith("hyd") || partId === "hyd_piston" ? C.yellowD : C.cyan);
        p.rect(2, h / 2 - 2, w - 4, 1, C.white);
        p.bolts4(2);
        cv = p.toCanvas();
      } else if (partId.startsWith("conduit") || partId === "reinforced_plate" || partId === "mount_plate") {
        p.bevel(0, 0, w, h, C.steelL);
        for (let x = 3; x < w - 3; x += 4) p.px(x, h - 3, C.steelD);
        p.bolts4(2);
        cv = p.toCanvas();
      } else if (partId === "hinge_block") {
        steelBox(p, C.steel);
        p.rect(w / 2 - 2, 2, 4, h - 4, C.steelD);
        p.rect(w / 2 - 1, h / 2 - 2, 2, 4, C.bolt);
        cv = p.toCanvas();
      } else if (partId === "turret_bearing") {
        steelBox(p, C.steelL);
        p.rect(3, h / 2 - 3, w - 6, 6, C.black);
        p.rect(3, h / 2 - 1, w - 6, 2, C.yellow);
        cv = p.toCanvas();
      } else if (partId === "ballast") {
        p.bevel(0, 0, w, h, "#4e4438");
        p.scratches(5, 8, "#3a322a");
        p.rect(2, h - 5, w - 4, 3, C.yellowD);
        cv = p.toCanvas();
      } else if (partId === "light") {
        steelBox(p, C.steel);
        p.rect(3, 3, w - 6, h - 6, C.yellow);
        p.rect(4, 4, w - 8, h - 8, C.white);
        cv = p.toCanvas();
      } else if (partId === "heatsink" || partId === "radiator" || partId === "coolant_tank" || partId === "fan") {
        steelBox(p, C.steelL);
        p.vents(3, 3, w - 6, h - 6, partId === "radiator" ? 5 : 4, C.copper);
        if (partId === "fan") p.rect(w / 2 - 2, h / 2 - 2, 4, 4, C.blue);
        cv = p.toCanvas();
      } else if (partId === "scrap_chunk") {
        p.bevel(0, 0, w, h, "#5a4a3a");
        p.scratches(3, 10, C.rust);
        cv = p.toCanvas();
      } else {
        steelBox(p);
        cv = p.toCanvas();
      }
    }
  }
  spriteCache.set(key, cv);
  return cv;
}

/** wheel sprites spin; we keep a separate circular canvas keyed the same way */
export function isCircularSprite(partId: string): boolean {
  return partId.startsWith("wheel") || partId === "spinner_disc" || partId === "spinner_disc_w";
}
