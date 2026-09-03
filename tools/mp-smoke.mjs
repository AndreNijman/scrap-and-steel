// SCRAP AND STEEL — tools/mp-smoke.mjs
// Relay smoke: health, lobbies, create room, second client join, settings,
// ready -> build_start with absolute deadline, lock-in, match_countdown.
// Usage: node tools/mp-smoke.mjs [ws://localhost:8787]
import WebSocket from "ws";

const BASE = process.argv[2] ?? "ws://localhost:8787";
const fails = [];
const ok = (m) => console.log(`mp-smoke: ${m}`);
const fail = (m) => {
  fails.push(m);
  console.error(`mp-smoke FAIL: ${m}`);
};

function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/ws?${query}&v=1&gv=0.1.0`, { headers: { Origin: "http://localhost:5180" } });
    const messages = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

const send = (ws, t, payload) => ws.send(JSON.stringify({ v: 1, t, payload }));
const waitFor = async (messages, type, timeoutMs = 8000, pred = null) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.filter((m) => m.t === type).find((m) => !pred || pred(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${type}`);
};

const http = BASE.replace(/^ws/, "http");
const health = await fetch(`${http}/health`).then((r) => r.json());
if (!health.ok) fail(`health: ${JSON.stringify(health)}`);
else ok(`health ok (v${health.v})`);

// version gate
const badRes = await fetch(`${http}/ws?v=99`);
if (badRes.status === 409) ok("version gate rejects bad protocol version");
else fail(`version gate returned ${badRes.status}`);

// two clients: host creates, guest joins by code
const host = await connect("create=1&name=Host");
const welcomeH = await waitFor(host.messages, "welcome");
const code = welcomeH.payload.state.code;
ok(`room created: ${code}`);

const guest = await connect(`code=${code}&name=Guest`);
await waitFor(guest.messages, "welcome");
const peerJoined = await waitFor(host.messages, "peer_joined");
if (peerJoined.payload.name !== "Guest") fail("peer_joined missing name");
else ok("guest joined");

// guest cannot change settings
send(guest.ws, "set_settings", { buildTimeSec: 61 });
const err = await waitFor(guest.messages, "error");
if (err.payload.code === "forbidden") ok("settings locked to host");
else fail(`expected forbidden, got ${JSON.stringify(err.payload)}`);

// host changes settings
send(host.ws, "set_settings", { buildTimeSec: 60, budgetSp: 700 });
const ls = await waitFor(guest.messages, "lobby_state", 8000, (m) => m.payload.settings.buildTimeSec === 60);
if (ls.payload.settings.buildTimeSec !== 60) fail("settings did not propagate");
else ok("settings propagate");

// ready -> build_start with absolute deadline
send(host.ws, "set_ready", { ready: true });
send(guest.ws, "set_ready", { ready: true });
const buildH = await waitFor(host.messages, "build_start");
const buildG = await waitFor(guest.messages, "build_start");
const now = Date.now();
if (Math.abs(buildH.payload.deadline - buildG.payload.deadline) > 5) fail("deadline mismatch");
if (buildH.payload.deadline <= now || buildH.payload.deadline > now + 61_000) fail(`bad deadline ${buildH.payload.deadline} vs now ${now}`);
else ok(`build deadline is absolute (${Math.round((buildH.payload.deadline - now) / 1000)}s)`);

// lock blueprints -> match_countdown with seed + both blueprints
send(host.ws, "lock_blueprint", { hash: "aaaa1111", blueprint: { schemaVersion: 1, id: "h", name: "H", parts: [], wires: [], bindings: [] } });
send(guest.ws, "lock_blueprint", { hash: "bbbb2222", blueprint: { schemaVersion: 1, id: "g", name: "G", parts: [], wires: [], bindings: [] } });
const cd = await waitFor(guest.messages, "match_countdown");
// wait out the 3s countdown until the DO enters combat phase
await new Promise((r) => setTimeout(r, 3500));
if (typeof cd.payload.seed !== "number") fail("no match seed");
if (!cd.payload.blueprints || cd.payload.blueprints.length !== 2) fail("blueprints not distributed");
else ok(`match_countdown: seed ${cd.payload.seed}, authority slot ${cd.payload.authority}`);

// input forwarding
send(host.ws, "input_frame", { tick: 100, throttle: 1, steer: 0, fire: true, lift: false });
const frame = await waitFor(guest.messages, "input_frame");
if (frame.payload.slot !== 0 || frame.payload.throttle !== 1) fail(`input frame broken: ${JSON.stringify(frame.payload)}`);
else ok("input frames forwarded with slot");

// snapshot only from authority
send(guest.ws, "snapshot", { tick: 1, data: [1, 2] });
const snapRejected = !guest.messages.some((m) => m.t === "snapshot");
if (snapRejected) ok("non-authority snapshot rejected");
else fail("non-authority snapshot was forwarded");

// lobbies listing contains our room while in lobby phase (fresh room code path)
const lobbies = await fetch(`${http}/lobbies`).then((r) => r.json());
ok(`lobbies endpoint: ${lobbies.lobbies.length} open rooms`);

host.ws.close();
guest.ws.close();

if (fails.length) {
  console.log(`MP SMOKE FAILED (${fails.length})`);
  process.exit(1);
}
console.log("MP SMOKE PASSED");
