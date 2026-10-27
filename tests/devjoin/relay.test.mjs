// Dev join against wrangler dev, with a throwaway Ed25519 key: the test signs
// passes with netdev.js's signDevPass and starts the relay with that key as
// DEV_TEST_PUBLIC_KEY. Scrap's join is the /ws query string, so the pass is
// `dev=<pass>` there. Covered: a dev creating a room; a dev joining a full
// lobby (spectates, everyone gets dev-joined with the name); forged, expired,
// other-host and bare-flag passes refused from the full room like anyone; a
// dev joining a running match (the match start, the inputs so far, then both
// players' live inputs); no kick; and the spectator taking the seat a player
// leaves (after the 30 s grace).
//
//   node tests/devjoin/relay.test.mjs
// Starts wrangler dev itself on 8875 (inspector 9375) with a private registry.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { signDevPass } from "../../worker/netdev.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 8875;
const BASE = `ws://127.0.0.1:${PORT}`;
const HOST = "scrap.andrenijman.com";
let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok:", m); } else { fail++; console.log("FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function keyPair() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { priv: b64url(await crypto.subtle.exportKey("pkcs8", k.privateKey)), pub: b64url(await crypto.subtle.exportKey("raw", k.publicKey)) };
}

const servers = [];
let registry = "";
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
async function startRelay(publicKey) {
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  const bin = process.env.WRANGLER || (existsSync(local) ? local : "npx");
  const pre = bin === "npx" ? ["wrangler"] : [];
  registry = mkdtempSync(path.join(tmpdir(), "scrap-registry-"));
  servers.push(spawn(bin, [...pre, "dev", "--port", String(PORT), "--inspector-port", "9375", "--ip", "127.0.0.1",
    "--var", "DEV_COLO:FRA", "--var", `DEV_TEST_PUBLIC_KEY:${publicKey}`],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, WRANGLER_REGISTRY_PATH: registry } }));
  if (!(await up(`http://127.0.0.1:${PORT}/health`))) throw new Error("wrangler dev did not come up");
}
function stopServers() {
  for (const p of servers) try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* still in use */ }
}

// A raw protocol client on /ws?<query>. Keeps every message, enveloped or not.
function client(query) {
  const ws = new WebSocket(`${BASE}/ws?${query}&v=1`, { headers: { Origin: "http://localhost" } });
  const c = { ws, msgs: [], opened: false, closed: null };
  ws.addEventListener("open", () => { c.opened = true; });
  ws.addEventListener("error", () => { c.errored = true; });
  ws.addEventListener("message", (ev) => c.msgs.push(JSON.parse(ev.data)));
  ws.addEventListener("close", (ev) => { c.closed = { code: ev.code, reason: ev.reason }; });
  c.send = (t, payload = {}) => ws.send(JSON.stringify({ v: 1, t, payload }));
  c.all = (t) => c.msgs.filter((m) => m.t === t);
  c.wait = async (t, ms = 8000) => {
    for (let i = 0; i < ms; i += 50) {
      const m = c.msgs.find((x) => x.t === t);
      if (m) return m.payload ?? m;
      if (c.closed) return null;
      await sleep(50);
    }
    return null;
  };
  // refused: the upgrade is answered 409, so the socket errors and never opens
  c.refused = async (ms = 5000) => {
    for (let i = 0; i < ms && !c.closed && !c.errored; i += 50) await sleep(50);
    await sleep(300);
    return !!(c.closed || c.errored) && !c.opened && !c.msgs.length;
  };
  return c;
}

async function fullLobby() {
  const a = client("create=1");
  const code = (await a.wait("welcome"))?.state.code;
  const b = client(`code=${code}`);
  await b.wait("welcome");
  return { code, a, b };
}

async function main() {
  const real = await keyPair();
  const other = await keyPair();
  await startRelay(real.pub);
  const sign = (o) => signDevPass(real.priv, { name: "Tester", host: HOST, ...o }).then((p) => encodeURIComponent(p.pass));
  const good = await sign({});

  // A dev creating a room is its host, and hears its own announcement.
  {
    const d = client(`create=1&dev=${good}`);
    const w = await d.wait("welcome");
    const dj = await d.wait("dev-joined");
    ok(w?.slot === 0 && w.host, "a dev creating a room gets seat 1");
    ok(dj && dj.name === "TESTER" && !("v" in dj) && !("payload" in dj), `dev-joined is {t, name}, unwrapped (${JSON.stringify(dj)})`);
    d.ws.close();
  }

  // A full lobby: bad passes are refused like anyone, a good one spectates.
  const lobby = await fullLobby();
  const bad = {
    "no pass": "",
    "forged (another key)": `&dev=${encodeURIComponent((await signDevPass(other.priv, { name: "Tester", host: HOST })).pass)}`,
    "expired": `&dev=${await sign({ ttl: 60, now: Date.now() - 20 * 60_000 })}`,
    "another game's host": `&dev=${await sign({ host: "fart.andrenijman.com" })}`,
    "a bare flag": "&dev=1&admin=1",
    "garbage": "&dev=v1.e30.AAAA",
  };
  for (const [label, q] of Object.entries(bad)) {
    const c = client(`code=${lobby.code}${q}`);
    ok(await c.refused(), `${label}: refused from the full room as before`);
  }
  ok(!lobby.a.all("dev-joined").length && !lobby.b.all("dev-joined").length, "nobody heard of the refused joins");
  const spec = client(`code=${lobby.code}&dev=${good}`);
  const sp = await spec.wait("spectate");
  ok(sp && sp.state.code === lobby.code && sp.state.players.filter(Boolean).length === 2, "a dev in the full lobby spectates; the roster stays the two players");
  for (const [name, c] of [["host", lobby.a], ["guest", lobby.b], ["dev", spec]]) {
    const dj = await c.wait("dev-joined");
    ok(dj?.name === "TESTER", `${name} gets dev-joined TESTER`);
  }
  // no kick exists; a host's attempt changes nothing
  lobby.a.send("kick", { slot: 2 });
  spec.send("ping", { t: 1, c: 7 });
  const pong = await spec.wait("pong");
  ok(pong?.c === 7 && !spec.closed, "the spectator stays (no kick) and gets pongs");
  // the guest leaves: after the 30 s grace the dev has the seat
  lobby.b.ws.close();
  const seated = spec.wait("welcome", 45_000);

  // A running match: the dev gets its start, the inputs so far, then live inputs.
  const m = await fullLobby();
  m.a.send("set_ready", { ready: true });
  m.b.send("set_ready", { ready: true });
  await m.a.wait("build_start");
  m.a.send("lock_blueprint", { blueprint: { parts: ["a"] }, hash: "ha" });
  m.b.send("lock_blueprint", { blueprint: { parts: ["b"] }, hash: "hb" });
  const mc = await m.a.wait("match_countdown");
  await sleep(Math.max(0, mc.startAt - Date.now()) + 1200); // the combat alarm
  for (let t = 0; t <= 40; t += 2) {
    m.a.send("input_frame", { tick: t, throttle: t >= 20 ? 1 : 0, steer: 0, fire: false, lift: false });
    m.b.send("input_frame", { tick: t, throttle: -1, steer: 0, fire: t >= 30, lift: false });
  }
  await m.b.wait("input_frame");
  await sleep(500);
  const late = client(`code=${m.code}&dev=${good}`);
  const lmc = await late.wait("match_countdown");
  ok(lmc?.spectate && lmc.resume && lmc.seed === mc.seed && JSON.stringify(lmc.blueprints) === JSON.stringify([{ parts: ["a"] }, { parts: ["b"] }]),
    "mid-match: the dev gets the match start (seed, both blueprints in seat order)");
  const log = await late.wait("spectate_log");
  ok(log?.done && log.complete && JSON.stringify(log.ticks) === "[40,40]" && log.entries.length === 4,
    `and the input changes so far (${JSON.stringify(log?.entries)}, ticks ${JSON.stringify(log?.ticks)})`);
  m.a.send("input_frame", { tick: 42, throttle: 0, steer: 0, fire: false, lift: false });
  m.b.send("input_frame", { tick: 42, throttle: 1, steer: 0, fire: false, lift: false });
  await sleep(800);
  const live = late.all("input_frame").map((x) => x.payload.slot).sort().join();
  ok(live === "0,1", `then both players' live inputs (slots ${live})`);
  ok(m.a.all("input_frame").every((x) => x.payload.slot === 1), "players still get only the other's inputs");
  for (const [name, c] of [["player 1", m.a], ["player 2", m.b], ["dev", late]]) ok((await c.wait("dev-joined"))?.name === "TESTER", `mid-match: ${name} gets dev-joined`);
  ok(m.a.all("lobby_state").pop()?.payload.players.filter(Boolean).length === 2, "the match keeps its two players");

  const w = await seated;
  ok(w?.slot === 1 && !w.host, "the spectator takes the seat the guest left");
  await sleep(300);
  const roster = lobby.a.all("lobby_state").pop()?.payload.players.map((p) => p?.name);
  ok(JSON.stringify(roster) === '["Player","TESTER"]', `and the host's roster shows the dev (${JSON.stringify(roster)})`);
  lobby.a.send("set_ready", { ready: true });
  spec.send("set_ready", { ready: true });
  ok(await spec.wait("build_start"), "and plays the next match");

  for (const c of [lobby.a, spec, m.a, m.b, late]) try { c.ws.close(); } catch { /* closed */ }
  console.log(`\n${pass} passed, ${fail} failed`);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopServers(); process.exit(1); });
setTimeout(() => { console.log("ERROR: test timed out"); stopServers(); process.exit(1); }, 150_000).unref();

main()
  .catch((e) => { console.log("ERROR:", e.stack || e.message); fail++; })
  .finally(() => { stopServers(); process.exit(fail ? 1 : 0); });
