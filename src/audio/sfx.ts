// SCRAP AND STEEL — audio/sfx.ts
// Fully procedural Web Audio sound design. No asset downloads. Initialized on
// the first user gesture. Master volume + mute persisted in localStorage.

const VOL_KEY = "scrap_volume_v1";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = loadVolume();
let muted = false;

function loadVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY) ?? "0.8");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  } catch {
    return 0.8;
  }
}

function persist() {
  try {
    localStorage.setItem(VOL_KEY, String(volume));
  } catch {
    // non-fatal
  }
}

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume * 0.9;
    master.connect(ctx.destination);
  } catch {
    ctx = null; // no audio support: game stays fully playable
  }
}

export function getVolume(): number {
  return volume;
}

export function setVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  persist();
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : volume * 0.9, ctx.currentTime, 0.02);
}

export function setMuted(m: boolean) {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : volume * 0.9, ctx.currentTime, 0.02);
}

export function isMuted(): boolean {
  return muted;
}

function now(): number {
  return ctx ? ctx.currentTime : 0;
}

let noiseBuffer: AudioBuffer | null = null;
function getNoise(): AudioBuffer | null {
  if (!ctx) return null;
  if (noiseBuffer) return noiseBuffer;
  const len = ctx.sampleRate * 1.2;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function envelope(g: GainNode, peak: number, attack: number, decay: number, t0: number) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

/** Short filtered noise burst (impacts, thunks, explosions). */
function noiseBurst(opts: {
  peak: number;
  attack: number;
  decay: number;
  filterType: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  delay?: number;
}) {
  if (!ctx || !master) return;
  const nb = getNoise();
  if (!nb) return;
  const t0 = now() + (opts.delay ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = nb;
  src.playbackRate.value = 0.7 + Math.random() * 0.6;
  const filt = ctx.createBiquadFilter();
  filt.type = opts.filterType;
  filt.frequency.setValueAtTime(opts.freq, t0);
  if (opts.freqEnd) filt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqEnd), t0 + opts.attack + opts.decay);
  filt.Q.value = opts.q ?? 1;
  const g = ctx.createGain();
  envelope(g, opts.peak, opts.attack, opts.decay, t0);
  src.connect(filt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + opts.attack + opts.decay + 0.05);
}

function tone(opts: {
  freq: number;
  freqEnd?: number;
  peak: number;
  attack: number;
  decay: number;
  type?: OscillatorType;
  delay?: number;
}) {
  if (!ctx || !master) return;
  const t0 = now() + (opts.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.freqEnd), t0 + opts.attack + opts.decay);
  const g = ctx.createGain();
  envelope(g, opts.peak, opts.attack, opts.decay, t0);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + opts.attack + opts.decay + 0.05);
}

// ---- one-shots ----

export const sfx = {
  uiClick() {
    tone({ freq: 900, freqEnd: 500, peak: 0.08, attack: 0.004, decay: 0.05, type: "square" });
  },
  uiHover() {
    tone({ freq: 1400, peak: 0.02, attack: 0.002, decay: 0.03, type: "sine" });
  },
  place() {
    noiseBurst({ peak: 0.25, attack: 0.004, decay: 0.12, filterType: "lowpass", freq: 900, freqEnd: 200 });
    tone({ freq: 180, freqEnd: 90, peak: 0.12, attack: 0.003, decay: 0.1, type: "triangle" });
  },
  delete() {
    noiseBurst({ peak: 0.18, attack: 0.002, decay: 0.09, filterType: "highpass", freq: 1200 });
  },
  wire() {
    tone({ freq: 2400, freqEnd: 3200, peak: 0.05, attack: 0.003, decay: 0.07, type: "sawtooth" });
  },
  weldBreak() {
    noiseBurst({ peak: 0.3, attack: 0.002, decay: 0.16, filterType: "bandpass", freq: 2400, freqEnd: 700, q: 2.5 });
    tone({ freq: 320, freqEnd: 120, peak: 0.12, attack: 0.002, decay: 0.14, type: "square" });
  },
  hit(force: number) {
    // normalized force 0..1 -> volume
    const v = 0.12 + 0.38 * Math.min(1, force);
    noiseBurst({ peak: v, attack: 0.001, decay: 0.1 + force * 0.1, filterType: "bandpass", freq: 1800, freqEnd: 500, q: 1.4 });
    tone({ freq: 240 - force * 90, freqEnd: 90, peak: v * 0.7, attack: 0.001, decay: 0.12, type: "triangle" });
  },
  explode() {
    noiseBurst({ peak: 0.5, attack: 0.005, decay: 0.5, filterType: "lowpass", freq: 1600, freqEnd: 90 });
    tone({ freq: 110, freqEnd: 34, peak: 0.45, attack: 0.004, decay: 0.55, type: "sine" });
    noiseBurst({ peak: 0.22, attack: 0.02, decay: 0.7, filterType: "lowpass", freq: 500, freqEnd: 60, delay: 0.08 });
  },
  countdown(final = false) {
    if (final) {
      tone({ freq: 520, peak: 0.2, attack: 0.005, decay: 0.35, type: "square" });
      tone({ freq: 780, peak: 0.14, attack: 0.005, decay: 0.35, type: "square", delay: 0.02 });
    } else {
      tone({ freq: 440, peak: 0.12, attack: 0.004, decay: 0.12, type: "square" });
    }
  },
  victory() {
    const notes = [392, 494, 587, 784];
    notes.forEach((f, i) => tone({ freq: f, peak: 0.14, attack: 0.01, decay: 0.3, type: "triangle", delay: i * 0.12 }));
  },
  defeat() {
    const notes = [392, 330, 262, 196];
    notes.forEach((f, i) => tone({ freq: f, peak: 0.12, attack: 0.01, decay: 0.34, type: "triangle", delay: i * 0.16 }));
  },
  draw() {
    tone({ freq: 440, peak: 0.1, attack: 0.01, decay: 0.3, type: "triangle" });
    tone({ freq: 440, peak: 0.08, attack: 0.01, decay: 0.3, type: "triangle", delay: 0.2 });
  },
};

// ---- continuous (looped) sounds ----

interface Loop {
  osc: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
}

let driveLoop: Loop | null = null;
let weaponLoop: Loop | null = null;

export function updateDriveSound(intensity: number) {
  // intensity 0..1 — throttle magnitude of the player's robot
  if (!ctx || !master) return;
  if (intensity <= 0.01) {
    if (driveLoop) {
      const l = driveLoop;
      driveLoop = null;
      l.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      setTimeout(() => l.osc.stop(), 400);
    }
    return;
  }
  if (!driveLoop) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 60;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(master);
    osc.start();
    driveLoop = { osc, gain, filter };
  }
  const t = ctx.currentTime;
  driveLoop.osc.frequency.setTargetAtTime(55 + intensity * 55, t, 0.08);
  driveLoop.gain.gain.setTargetAtTime(0.05 + intensity * 0.06, t, 0.08);
}

export function updateWeaponSound(spin: number) {
  // spin 0..1 — weapon spin-up progress of the player's robot
  if (!ctx || !master) return;
  if (spin <= 0.01) {
    if (weaponLoop) {
      const l = weaponLoop;
      weaponLoop = null;
      l.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      setTimeout(() => l.osc.stop(), 500);
    }
    return;
  }
  if (!weaponLoop) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 140;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 900;
    filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(master);
    osc.start();
    weaponLoop = { osc, gain, filter };
  }
  const t = ctx.currentTime;
  weaponLoop.osc.frequency.setTargetAtTime(120 + spin * 520, t, 0.06);
  weaponLoop.filter.frequency.setTargetAtTime(500 + spin * 1600, t, 0.06);
  weaponLoop.gain.gain.setTargetAtTime(0.02 + spin * 0.05, t, 0.06);
}

export function stopLoops() {
  if (ctx) {
    updateDriveSound(0);
    updateWeaponSound(0);
  }
}
