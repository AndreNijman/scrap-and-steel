// One game client (src/game/net.ts, the real RelayClient) in Node, for
// rooms.test.mjs: run with vite-node so the TypeScript imports resolve.
//   vite-node tests/latency/client-agent.mjs -- <relay ws url> <create=1 | code=XXXXX> '<probes json>' <rtt>
// It pretends to be on scrap.andrenijman.com so netprobe.js probes regions;
// each region's probe answers after that region's ms from <probes>, and its
// pings report <rtt>. It readies 2.5 s after its first welcome and prints one
// JSON line per relay event, then `done` once a build phase starts.
const [relayUrl, query, probesJson, rttArg] = process.argv.slice(2).filter((a) => a !== "--");
const probes = JSON.parse(probesJson);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { protocol: "https:", hostname: "scrap.andrenijman.com", search: "" };
globalThis.window = globalThis;
globalThis.document = { hidden: false };
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
// A browser sends its page's Origin, which the relay checks.
const NodeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) { super(url, { headers: { Origin: "http://localhost" } }); }
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const region = /^\/_guard\/probe\/(\w+)$/.exec(String(url))?.[1];
  if (!region) return realFetch(url, init);
  if (!probes[region]) return new Response("", { status: 404 });
  await sleep(probes[region]);
  return new Response("ok");
};

const { NetPing } = await import("../../src/game/netping.js");
const next = NetPing.prototype.next;
NetPing.prototype.next = function () { return { ...next.call(this), rtt: Number(rttArg) }; };
const { RelayClient } = await import("../../src/game/net.ts");

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const relay = new RelayClient(relayUrl);
let readied = false;
relay.on((e) => {
  if (e.kind !== "message") { out({ kind: e.kind }); return; }
  out({ t: e.t, payload: e.t === "welcome" ? { slot: e.payload.slot, region: e.payload.region, code: e.payload.state?.code } : e.payload, url: relay.ws?.url, shard: relay.shard });
  if (e.t === "welcome" && !readied) {
    readied = true;
    setTimeout(() => relay.send("set_ready", { ready: true }), 2500);
  }
  if (e.t === "build_start") {
    out({ done: true, url: relay.ws?.url, region: relay.region, code: relay.roomCode, movingTo: relay.movingTo });
    setTimeout(() => { relay.close(); process.exit(0); }, 200);
  }
});
relay.connect(query);
setTimeout(() => { out({ timeout: true }); process.exit(1); }, 25_000);
