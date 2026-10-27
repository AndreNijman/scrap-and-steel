// Integration test for room placement against wrangler dev: a mixed pair (one
// far away, by their fake probe results) readies up and gets moved; they
// reconnect with tickets and the build phase starts on the shard. A second
// moved pair where only the host comes back: after the 6 s wait the shard
// drops the empty seat, and a later joiner to the old code lands there. A
// same-region pair is not moved. Also /ping (region, CORS), the internal
// routes staying internal, and the lag records (country, region, moved) as
// received by a stub NetLog.
//
// By default it starts both servers itself on 8870 (relay) and 8871 (NetLog
// stub) with WRANGLER (default: node_modules/.bin/wrangler, else npx):
//   node tests/latency/rooms.test.mjs
// The two share a private dev registry, so the relay's NETLOG binding can't
// reach another "games-guard" running locally. Or against servers you started:
//   export WRANGLER_REGISTRY_PATH=$(mktemp -d)
//   wrangler dev -c tests/latency/netlog-stub.jsonc --port 8871 --inspector-port 9371 &
//   wrangler dev --port 8870 --inspector-port 9370 --var DEV_TRUST_WHERE:1 --var DEV_COLO:FRA &
//   RELAY=ws://localhost:8870 NETLOG=http://localhost:8871 node tests/latency/rooms.test.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let BASE = process.env.RELAY || "";
let NETLOG = process.env.NETLOG || "";
let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
let registry = "";
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
async function startServers() {
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  const bin = process.env.WRANGLER || (existsSync(local) ? local : "npx");
  const pre = bin === "npx" ? ["wrangler"] : [];
  registry = mkdtempSync(path.join(tmpdir(), "scrap-registry-"));
  const run = (args) => {
    const p = spawn(bin, [...pre, ...args], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true,
      env: { ...process.env, WRANGLER_REGISTRY_PATH: registry } });
    servers.push(p);
  };
  run(["dev", "-c", "tests/latency/netlog-stub.jsonc", "--port", "8871", "--inspector-port", "9371", "--ip", "127.0.0.1"]);
  run(["dev", "--port", "8870", "--inspector-port", "9370", "--ip", "127.0.0.1", "--var", "DEV_TRUST_WHERE:1", "--var", "DEV_COLO:FRA"]);
  BASE = "ws://127.0.0.1:8870";
  NETLOG = "http://127.0.0.1:8871";
  if (!(await up(`${NETLOG}/`)) || !(await up("http://127.0.0.1:8870/health"))) throw new Error("wrangler dev did not come up");
  await sleep(1500); // let the dev registry connect the NETLOG binding
}
function stopServers() {
  for (const p of servers) try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* still in use */ }
}

// A raw protocol client on /ws?<query>; `country` is faked with DEV_TRUST_WHERE.
function client(query, country = "") {
  const headers = { Origin: "http://localhost" };
  if (country) Object.assign(headers, { "X-Games-Country": country, "X-Games-Edge": "TST" });
  const ws = new WebSocket(`${BASE}/ws?${query}&v=1`, { headers });
  const c = { ws, msgs: [], waiters: [], closed: null };
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const w = c.waiters.find((x) => x.type === m.t);
    if (w) { c.waiters = c.waiters.filter((x) => x !== w); w.resolve(m.payload); } else c.msgs.push(m);
  });
  ws.addEventListener("close", (ev) => { c.closed = { code: ev.code, reason: ev.reason }; });
  c.send = (t, payload = {}) => ws.send(JSON.stringify({ v: 1, t, payload }));
  c.wait = (type, timeout = 5000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find((m) => m.t === type);
    if (hit) { c.msgs = c.msgs.filter((m) => m !== hit); return resolve(hit.payload); }
    const w = { type, resolve };
    c.waiters.push(w);
    setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); reject(new Error("timeout waiting " + type)); }, timeout);
  });
  c.has = (type) => c.msgs.some((m) => m.t === type);
  c.last = (type) => c.msgs.filter((m) => m.t === type).pop()?.payload;
  return c;
}
const http = () => BASE.replace(/^ws/, "http");

const EUROPE = { weur: 20, eeur: 45, me: 140, apac: 290, oc: 330 };
const ASIA = { weur: 290, eeur: 250, me: 150, apac: 30, oc: 120 };

// Host creates, guest joins by code; each reports probes and five pings; both ready.
async function pair(host, guest) {
  const a = client("create=1", host.country);
  const wa = await a.wait("welcome");
  const code = wa.state.code;
  const b = client(`code=${code}`, guest.country);
  await b.wait("welcome");
  for (const [c, p] of [[a, host], [b, guest]]) {
    c.send("regions", { ms: p.probes });
    for (let k = 0; k < 5; k++) c.send("ping", { c: k, rtt: p.rtt });
  }
  await sleep(200);
  a.send("set_ready", { ready: true });
  b.send("set_ready", { ready: true });
  return { code, a, b, region: wa.region };
}
// Keep lag stats flowing (a record needs 10 s of match).
function chatter(clients, rtt) {
  return setInterval(() => {
    for (const [i, c] of clients.entries()) if (c.ws.readyState === 1) c.send("ping", { c: 1, rtt: rtt[i], fps: 60, frameMax: 20 });
  }, 250);
}
// Lock both, wait for combat, then drop the guest: 12 s later the room forfeits and logs.
async function fightThenDrop(a, b) {
  for (const c of [a, b]) c.send("lock_blueprint", { blueprint: { parts: [] }, hash: "h" });
  await a.wait("match_countdown").catch(() => null);
  await sleep(3600); // countdown, then the combat alarm
  b.ws.close();
  return a.wait("result", 20_000).catch(() => null);
}

async function main() {
  if (!BASE) await startServers();

  // /ping: where a room runs, with CORS; bad codes and internal routes are refused.
  {
    const res = await fetch(`${http()}/ping?room=ABCDE`);
    const body = await res.json();
    ok(res.ok && body.region === "weur" && body.colo === "FRA", `room /ping answers its region (${JSON.stringify(body)})`);
    ok(res.headers.get("access-control-allow-origin") === "*" && res.headers.get("cache-control") === "no-store", "/ping has CORS and no-store");
    ok((await fetch(`${http()}/ping?room=no`)).status === 400, "/ping refuses a malformed room code");
    ok((await fetch(`${http()}/ping?room=ABCDE&shard=xx-1`)).status === 400, "/ping refuses a malformed shard");
    ok((await fetch(`${http()}/_adopt`, { method: "POST", body: "{}" })).status === 404, "/_adopt is not reachable from outside");
    ok((await fetch(`${http()}/_released`, { method: "POST", body: "{}" })).status === 404, "/_released is not reachable from outside");
    ok((await fetch(`${http()}/room?code=ABCDE`)).status === 404, "the DO's /room path is not reachable from outside");
  }

  // A same-region pair starts where it is.
  const stay = await pair({ probes: EUROPE, rtt: 25, country: "FR" }, { probes: EUROPE, rtt: 30, country: "BE" });
  const stayStart = await stay.a.wait("build_start").catch(() => null);
  await sleep(300);
  ok(stayStart && !stay.a.has("move") && !stay.b.has("move"), "a same-region pair does not move");
  ok(stay.region === "weur", "welcome carries the room's region");
  const stayTalk = chatter([stay.a, stay.b], [25, 30]);
  const stayDone = fightThenDrop(stay.a, stay.b);

  // A mixed pair moves to the fairest region and the build phase starts on the shard.
  const mixed = await pair({ probes: EUROPE, rtt: 300, country: "DE" }, { probes: ASIA, rtt: 30, country: "SG" });
  const moves = await Promise.all([mixed.a, mixed.b].map((c) => c.wait("move").catch(() => null)));
  ok(moves.every((m) => m && m.shard === moves[0].shard && m.region === "me" && /^[a-z0-9]{16}$/.test(m.ticket)),
    `both get move to the same shard with a ticket (${moves[0]?.shard})`);
  ok(!mixed.a.has("build_start") && !mixed.b.has("build_start"), "the old room does not start the build phase");
  const shard = moves[0]?.shard;
  await sleep(1300);
  ok([mixed.a, mixed.b].every((c) => c.closed?.code === 4000 && c.closed?.reason === "moved"), "old sockets close with 4000 moved");
  const back = [
    client(`code=${mixed.code}&shard=${shard}&ticket=${moves[0]?.ticket}`, "DE"),
    client(`code=${mixed.code}&shard=${shard}&ticket=${moves[1]?.ticket}`, "SG"),
  ];
  const welcomes = await Promise.all(back.map((c) => c.wait("welcome").catch(() => null)));
  ok(welcomes[0]?.slot === 0 && welcomes[0]?.host && welcomes[1]?.slot === 1 && welcomes[0]?.region === "me", "each ticket gets its seat back; the shard's region is me");
  const starts = await Promise.all(back.map((c) => c.wait("build_start", 8000).catch(() => null)));
  ok(starts.every(Boolean), "the build phase starts on the shard once both tickets are back");
  const shardPing = await fetch(`${http()}/ping?room=${mixed.code}&shard=${shard}`);
  ok(shardPing.ok && (await shardPing.json()).region === "me", "/ping with the shard answers the shard's region");
  const talk = chatter(back, [300, 30]);
  const movedDone = fightThenDrop(back[0], back[1]);

  // A moved pair where only the host comes back; a late joiner fills the seat.
  const half = await pair({ probes: EUROPE, rtt: 300, country: "DE" }, { probes: ASIA, rtt: 30, country: "SG" });
  const hm = await half.a.wait("move").catch(() => null);
  await half.b.wait("move").catch(() => null);
  half.a.ws.close();
  half.b.ws.close();
  const host = client(`code=${half.code}&shard=${hm?.shard}&ticket=${hm?.ticket}`, "DE");
  await host.wait("welcome").catch(() => null);
  const dropped = await host.wait("lobby_state", 8000).then(async () => {
    for (let i = 0; i < 40; i++) {
      const st = host.last("lobby_state");
      if (st && st.players[1] === null) return st;
      await sleep(250);
    }
    return null;
  }).catch(() => null);
  ok(dropped && dropped.players[0]?.name && !host.has("build_start"), "after 6 s the shard drops the seat nobody came back to");
  const late = client(`code=${half.code}`, "AU");
  const lateMove = await late.wait("move").catch(() => null);
  ok(lateMove?.shard === hm?.shard && !lateMove?.ticket, "a late joiner to the old code gets move without a ticket");
  late.send("ping", { c: 1 }); // as a client that ignores `move` would
  await sleep(500);
  ok(late.closed?.code === 4000 && late.closed?.reason === "moved", `and that socket to the old room closes with 4000 moved on its next message (${JSON.stringify(late.closed)})`);
  const late2 = client(`code=${half.code}&shard=${lateMove?.shard}`, "AU");
  const lateWelcome = await late2.wait("welcome").catch(() => null);
  ok(lateWelcome?.slot === 1 && lateWelcome?.state?.code === half.code && lateWelcome?.region === "me", "the late joiner lands in the moved room");
  late2.send("set_ready", { ready: true });
  ok(await late2.wait("build_start").catch(() => null), "and the match starts there");

  // The lag records, as the stub NetLog got them.
  await Promise.all([stayDone, movedDone]);
  clearInterval(talk);
  clearInterval(stayTalk);
  let records = [];
  for (let i = 0; i < 20; i++) {
    records = (await (await fetch(`${NETLOG}/records`)).json()).map((r) => r.record);
    if (records.some((r) => r.code === mixed.code) && records.some((r) => r.code === stay.code)) break;
    await sleep(250);
  }
  const movedRec = records.find((r) => r.code === mixed.code);
  const stayRec = records.find((r) => r.code === stay.code);
  ok(movedRec && movedRec.region === "me" && movedRec.moved?.from === "FRA" && movedRec.moved?.to === "me",
    `moved record: region and moved (${JSON.stringify(movedRec && { region: movedRec.region, moved: movedRec.moved })})`);
  ok(movedRec && movedRec.seats.map((s) => s.country).join() === "DE,SG" && movedRec.seats.every((s) => s.edge === "TST"), "moved record: each player's country and edge");
  ok(stayRec && stayRec.region === "weur" && stayRec.moved === null && stayRec.seats.map((s) => s.country).join() === "FR,BE", "unmoved record: region, moved null, countries");

  for (const c of [stay.a, stay.b, ...back, host, late, late2]) try { c.ws.close(); } catch { /* closed */ }

  await realClients();
  console.log(`${pass} passed, ${fail} failed`);
}

// The game's own client (src/game/net.ts) through a move, one process each
// (tests/latency/client-agent.mjs): probes, `move`, reconnect with its ticket,
// the build phase on the shard, and no disconnect seen on the way.
function agent(query, probes, rtt) {
  const bin = path.join(ROOT, "node_modules/.bin/vite-node");
  const p = spawn(bin, ["tests/latency/client-agent.mjs", "--", BASE, query, JSON.stringify(probes), String(rtt)], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const a = { events: [], exited: new Promise((resolve) => p.on("exit", resolve)) };
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) try { a.events.push(JSON.parse(buf.slice(0, i))); } catch { /* not ours */ }
  });
  a.first = async (pred, ms = 15_000) => {
    for (let t = 0; t < ms; t += 100) { const e = a.events.find(pred); if (e) return e; await sleep(100); }
    return null;
  };
  return a;
}

async function realClients() {
  const host = agent("create=1", EUROPE, 300);
  const code = (await host.first((e) => e.t === "welcome"))?.payload.code;
  const guest = agent(`code=${code}`, ASIA, 30);
  await Promise.all([host.exited, guest.exited]);
  for (const [name, a] of [["host", host], ["guest", guest]]) {
    const move = a.events.find((e) => e.t === "move");
    const welcomes = a.events.filter((e) => e.t === "welcome");
    const done = a.events.find((e) => e.done);
    ok(move?.payload.region === "me" && move.payload.ticket, `${name}: the client gets move (${JSON.stringify(move?.payload)})`);
    ok(done && /shard=me-/.test(done.url) && /ticket=/.test(done.url) && done.code === code && done.region === "me",
      `${name}: it reconnected to the shard with its ticket and the build phase started there (${done?.url})`);
    ok(welcomes.length === 2 && welcomes[0].payload.slot === welcomes[1].payload.slot, `${name}: same seat after the move`);
    ok(!a.events.some((e) => e.kind === "close" || e.kind === "error" || e.timeout), `${name}: no disconnect or error on the way`);
  }
}

// Never leave wrangler running: on a signal, or if the test hangs.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopServers(); process.exit(1); });
setTimeout(() => { console.log("ERROR: test timed out"); stopServers(); process.exit(1); }, 150_000).unref();

main()
  .catch((e) => { console.log("ERROR:", e.stack || e.message); fail++; })
  .finally(() => { stopServers(); process.exit(fail ? 1 : 0); });
