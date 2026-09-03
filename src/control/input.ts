// SCRAP AND STEEL — control/input.ts
// Keyboard input mapping. All gameplay actions are remappable (release gate):
// bindings live in localStorage, never hard-coded at the use site.

export interface Keybinds {
  forward: string;
  back: string;
  left: string;
  right: string;
  fire: string;
  lift: string;
}

export const DEFAULT_BINDS: Keybinds = {
  forward: "KeyW",
  back: "KeyS",
  left: "KeyA",
  right: "KeyD",
  fire: "Space",
  lift: "ShiftLeft",
};

const BINDS_KEY = "scrap_keybinds_v1";

export function loadBinds(): Keybinds {
  try {
    const raw = localStorage.getItem(BINDS_KEY);
    if (raw) return { ...DEFAULT_BINDS, ...JSON.parse(raw) };
  } catch {
    // fall through
  }
  return { ...DEFAULT_BINDS };
}

export function saveBinds(b: Keybinds) {
  try {
    localStorage.setItem(BINDS_KEY, JSON.stringify(b));
  } catch {
    // non-fatal
  }
}

export class InputState {
  binds: Keybinds = loadBinds();
  private down = new Set<string>();
  throttle = 0;
  steer = 0;
  fire = false;
  lift = false;

  constructor() {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", () => this.down.clear());
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.type === "keydown") this.down.add(e.code);
    else this.down.delete(e.code);
  };

  /** Recompute axis state; call once per frame. */
  update() {
    const fwd = this.down.has(this.binds.forward) ? 1 : 0;
    const back = this.down.has(this.binds.back) ? 1 : 0;
    const left = this.down.has(this.binds.left) ? 1 : 0;
    const right = this.down.has(this.binds.right) ? 1 : 0;
    this.throttle = fwd - back;
    this.steer = right - left;
    this.fire = this.down.has(this.binds.fire);
    this.lift = this.down.has(this.binds.lift);
  }
}
