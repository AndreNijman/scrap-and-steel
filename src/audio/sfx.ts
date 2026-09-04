// SCRAP & STEEL — audio/sfx.ts
// Procedural mechanical sound design: motors, servos, hydraulics, impacts,
// weapons, UI. No audio assets — everything synthesized.

const VOL_KEY = "scrap2d_volume";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = loadVolume();

function loadVolume(): number {
  try { return Math.min(1, Math.max(0, parseFloat(localStorage.getItem(VOL_KEY) ?? "0.7"))); } catch { return 0.7; }
}

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume * 0.85;
    master.connect(ctx.destination);
  } catch { ctx = null; }
}

export function getVolume() { return volume; }
export function setVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* ignore */ }
  if (master) master.gain.value = volume * 0.85;
}

function now() { return ctx?.currentTime ?? 0; }

let noiseBuf: AudioBuffer | null = null;
function noise(): AudioBuffer | null {
  if (!ctx) return null;
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function burst(o: { peak: number; attack: number; decay: number; type: BiquadFilterType; freq: number; freqEnd?: number; q?: number; delay?: number; playback?: number }) {
  if (!ctx || !master) return;
  const nb = noise();
  if (!nb) return;
  const t0 = now() + (o.delay ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = nb;
  src.playbackRate.value = o.playback ?? 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = o.type;
  f.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqEnd), t0 + o.attack + o.decay);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.peak, t0 + o.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.attack + o.decay);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + o.attack + o.decay + 0.05);
}

function tone(o: { freq: number; freqEnd?: number; peak: number; attack: number; decay: number; type?: OscillatorType; delay?: number }) {
  if (!ctx || !master) return;
  const t0 = now() + (o.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.freqEnd), t0 + o.attack + o.decay);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.peak, t0 + o.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.attack + o.decay);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + o.attack + o.decay + 0.05);
}

export const sfx = {
  uiClick() { tone({ freq: 880, freqEnd: 520, peak: 0.06, attack: 0.003, decay: 0.05, type: "square" }); },
  place() {
    burst({ peak: 0.2, attack: 0.004, decay: 0.1, type: "lowpass", freq: 800, freqEnd: 180 });
    tone({ freq: 160, freqEnd: 85, peak: 0.1, attack: 0.003, decay: 0.09, type: "triangle" });
  },
  delete() { burst({ peak: 0.14, attack: 0.002, decay: 0.08, type: "highpass", freq: 1400 }); },
  wire() { tone({ freq: 2200, freqEnd: 3100, peak: 0.05, attack: 0.003, decay: 0.06, type: "sawtooth" }); },
  hit(force: number) {
    const v = 0.1 + 0.35 * Math.min(1, force);
    burst({ peak: v, attack: 0.001, decay: 0.09 + force * 0.1, type: "bandpass", freq: 1700, freqEnd: 480, q: 1.3 });
    tone({ freq: 220 - force * 80, freqEnd: 85, peak: v * 0.6, attack: 0.001, decay: 0.11, type: "triangle" });
  },
  explode() {
    burst({ peak: 0.42, attack: 0.005, decay: 0.45, type: "lowpass", freq: 1500, freqEnd: 85 });
    tone({ freq: 105, freqEnd: 32, peak: 0.4, attack: 0.004, decay: 0.5, type: "sine" });
  },
  shot() {
    burst({ peak: 0.3, attack: 0.001, decay: 0.14, type: "bandpass", freq: 900, freqEnd: 200, q: 0.8 });
    tone({ freq: 190, freqEnd: 60, peak: 0.25, attack: 0.001, decay: 0.13, type: "square" });
  },
  servo() { tone({ freq: 1200, freqEnd: 1500, peak: 0.04, attack: 0.01, decay: 0.12, type: "sawtooth" }); },
  countdown(final = false) {
    if (final) { tone({ freq: 520, peak: 0.18, attack: 0.005, decay: 0.3, type: "square" }); tone({ freq: 780, peak: 0.12, attack: 0.005, decay: 0.3, type: "square", delay: 0.02 }); }
    else tone({ freq: 440, peak: 0.1, attack: 0.004, decay: 0.1, type: "square" });
  },
  victory() { [392, 494, 587, 784].forEach((f, i) => tone({ freq: f, peak: 0.13, attack: 0.01, decay: 0.28, type: "triangle", delay: i * 0.11 })); },
  defeat() { [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, peak: 0.11, attack: 0.01, decay: 0.3, type: "triangle", delay: i * 0.15 })); },
  draw() { tone({ freq: 440, peak: 0.09, attack: 0.01, decay: 0.28, type: "triangle" }); tone({ freq: 440, peak: 0.07, attack: 0.01, decay: 0.28, type: "triangle", delay: 0.2 }); },
};

// continuous loops
interface Loop { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }
let driveLoop: Loop | null = null;
let weaponLoop: Loop | null = null;

export function updateDriveSound(intensity: number) {
  if (!ctx || !master) return;
  if (intensity <= 0.02) {
    if (driveLoop) { const l = driveLoop; driveLoop = null; l.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08); setTimeout(() => l.osc.stop(), 400); }
    return;
  }
  if (!driveLoop) {
    const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 58;
    const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 300;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(master); osc.start();
    driveLoop = { osc, gain, filter };
  }
  const t = ctx.currentTime;
  driveLoop.osc.frequency.setTargetAtTime(52 + intensity * 60, t, 0.08);
  driveLoop.gain.gain.setTargetAtTime(0.04 + intensity * 0.05, t, 0.08);
}

export function updateWeaponSound(spin: number) {
  if (!ctx || !master) return;
  if (spin <= 0.02) {
    if (weaponLoop) { const l = weaponLoop; weaponLoop = null; l.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); setTimeout(() => l.osc.stop(), 500); }
    return;
  }
  if (!weaponLoop) {
    const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 130;
    const filter = ctx.createBiquadFilter(); filter.type = "bandpass"; filter.frequency.value = 850; filter.Q.value = 3;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(master); osc.start();
    weaponLoop = { osc, gain, filter };
  }
  const t = ctx.currentTime;
  weaponLoop.osc.frequency.setTargetAtTime(110 + spin * 540, t, 0.06);
  weaponLoop.filter.frequency.setTargetAtTime(450 + spin * 1500, t, 0.06);
  weaponLoop.gain.gain.setTargetAtTime(0.02 + spin * 0.045, t, 0.06);
}

export function stopLoops() {
  if (!ctx) return;
  updateDriveSound(0);
  updateWeaponSound(0);
}
