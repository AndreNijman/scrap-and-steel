// Item 1 measurement: how far the two players' simulations drift apart.
//   node_modules/.bin/vite-node tests/latency/harness.mjs
// An online match runs one Simulation on each client. Each client drives its
// own robot from its keys and the other robot from the latest input_frame
// that has arrived (sent every 2nd tick, applied on arrival, no input delay),
// exactly as src/main.ts does. Here both clients are in one process with
// scripted, deterministic inputs, ticks aligned (the best case), and each
// input_frame arrives after a one-way delay of 100 ms +-20 (200 ms RTT).
// Printed per run: the mean distance between a robot in its owner's sim and
// the same robot in the other player's sim, the % of ticks where the two sims
// disagree on which parts are destroyed, and whether they pick the same winner.
// Two controls: both sims fed the same inputs (determinism), and 0 ms delay
// with input_frame every 2nd tick (what the send rate alone costs).
import { initPhysics } from "../../src/game/physics";
import { Simulation } from "../../src/game/sim";
import { ARENAS } from "../../src/game/arena";
import { BOT_SPECS } from "../../src/game/bots";

const TICK = 1 / 60;
const TICKS = 60 * 45; // 45 s of combat, or until the match ends
const MATCHES = 6;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A player's keys for every tick: hold a random mix for 0.3-1.2 s, then change. */
function script(seed) {
  const r = rng(seed);
  const out = [];
  let cur = null;
  let left = 0;
  for (let t = 0; t <= TICKS; t++) {
    if (left-- <= 0) {
      const dir = r();
      cur = { forward: dir < 0.6 ? 1 : 0, back: dir > 0.85 ? 1 : 0, fire: r() < 0.6 ? 1 : 0, aux: r() < 0.3 ? 1 : 0, turret: [-1, 0, 0, 1][Math.floor(r() * 4)] };
      left = 18 + Math.floor(r() * 54);
    }
    out.push(cur);
  }
  return out;
}

const pos = (side) => side?.phys.rootBody?.getPosition() ?? null;
const destroyed = (side) => side ? [...side.phys.bodies].filter(([, b]) => b.destroyed).map(([id]) => id).sort().join(",") : "";

function match({ seed, bpA, bpB, oneWayMs, jitterMs }) {
  const sims = [0, 1].map(() => new Simulation({ bpA: structuredClone(bpA), bpB: structuredClone(bpB), arena: ARENAS.scrapyard, seed }));
  const keys = [script(seed * 2 + 1), script(seed * 2 + 2)];
  const net = rng(seed ^ 0x5eed);
  const inFlight = []; // { at, to, input }
  const remote = [{ forward: 0, back: 0, fire: 0, aux: 0, turret: 0 }, { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 }];
  let err = 0, errN = 0, partTicks = 0, ticks = 0;
  for (let t = 0; t < TICKS; t++) {
    const now = t * TICK * 1000;
    // deliver what has arrived; the newest arrival wins even if it was sent earlier
    inFlight.sort((a, b) => a.at - b.at);
    while (inFlight.length && inFlight[0].at <= now) { const m = inFlight.shift(); remote[m.to] = m.input; }
    for (const me of [0, 1]) {
      const sim = sims[me];
      const input = keys[me][t];
      if (sim.tick % 2 === 0) inFlight.push({ at: now + oneWayMs + (net() * 2 - 1) * jitterMs, to: 1 - me, input: { ...input } });
      const mine = sim.robots[me], other = sim.robots[1 - me];
      if (mine && !mine.defeated) mine.input = { ...input };
      if (other && !other.defeated) other.input = { ...(oneWayMs === null ? keys[1 - me][t] : remote[me]) }; // what player `me` has received
      sim.step(TICK);
    }
    for (const r of [0, 1]) {
      const own = pos(sims[r].robots[r]), seen = pos(sims[1 - r].robots[r]);
      if (own && seen) { err += Math.hypot(own.x - seen.x, own.y - seen.y); errN++; }
    }
    ticks++;
    if ([0, 1].some((r) => destroyed(sims[0].robots[r]) !== destroyed(sims[1].robots[r]))) partTicks++;
    if (sims[0].outcome && sims[1].outcome) break;
  }
  const winner = (s) => (s.outcome ? (s.outcome.kind === "timeout" ? "draw" : String(s.outcome.winner)) : "none");
  return { err: errN ? err / errN : 0, partPct: (100 * partTicks) / ticks, sameWinner: winner(sims[0]) === winner(sims[1]), ticks };
}

function run(label, oneWayMs, jitterMs) {
  const rows = [];
  for (let m = 0; m < MATCHES; m++) {
    const a = BOT_SPECS[m % BOT_SPECS.length], b = BOT_SPECS[(m + 2) % BOT_SPECS.length];
    rows.push(match({ seed: 1000 + m, bpA: a.build(), bpB: b.build(), oneWayMs, jitterMs }));
  }
  const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const same = rows.filter((r) => r.sameWinner).length;
  console.log(`${label.padEnd(34)} position error ${mean("err").toFixed(2)} m · parts disagree ${mean("partPct").toFixed(1)}% of ticks · same winner ${same}/${rows.length}`);
  return rows;
}

await initPhysics();
console.log(`${MATCHES} scripted matches, scrapyard, up to ${TICKS / 60} s each, ticks aligned`);
run("control: same inputs, no network", null, 0);
run("control: 0 ms, 30 Hz input_frame", 0, 0);
run("before: 100 ms +-20 one way", 100, 20);
run("after: no sim change (TIER-2)", 100, 20);
