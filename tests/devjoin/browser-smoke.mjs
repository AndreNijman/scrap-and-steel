// Browser smoke for dev join: the built game in three headless Chromium pages
// against wrangler dev started with a throwaway DEV_TEST_PUBLIC_KEY. Host and
// guest play a match; a third page opens the admin page's link
// https://scrap.andrenijman.com/?join=CODE mid-match, its /_guard/dev answering
// a pass signed with the test key (the page is served by Playwright routes, so
// devPass() sees the real host). The dev spectates: their copy of the match
// catches up and runs, every page shows "DEV TESTER HAS JOINED", and each page
// has window.__gamesPlayer for the admin page. Fails on any page error.
//   npm run build && node tests/devjoin/browser-smoke.mjs
// Ports: relay 8877 (inspector 9377), static 8878. PLAYWRIGHT_CORE and CHROME
// pick the browser; screenshots go to SHOTS (default tests/devjoin/).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { signDevPass } from "../../worker/netdev.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = path.join(ROOT, "dist");
const SHOTS = process.env.SHOTS || HERE;
const PW = process.env.PLAYWRIGHT_CORE || "/var/home/andre/Projects/site/games.andrenijman.com/river-flume/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME || "/var/home/andre/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const RELAY_PORT = 8877, WEB_PORT = 8878;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok:", m); } else { fail++; console.log("FAIL:", m); } };

const servers = [];
let registry = "";
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
async function startWrangler(publicKey) {
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  const bin = process.env.WRANGLER || (existsSync(local) ? local : "npx");
  const pre = bin === "npx" ? ["wrangler"] : [];
  registry = mkdtempSync(path.join(tmpdir(), "scrap-registry-"));
  servers.push(spawn(bin, [...pre, "dev", "--port", String(RELAY_PORT), "--inspector-port", "9377", "--ip", "127.0.0.1",
    "--var", "DEV_COLO:FRA", "--var", `DEV_TEST_PUBLIC_KEY:${publicKey}`],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, WRANGLER_REGISTRY_PATH: registry } }));
  if (!(await up(`http://127.0.0.1:${RELAY_PORT}/health`))) throw new Error("wrangler dev did not come up");
}
function stop() {
  for (const p of servers) try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* in use */ }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const distFile = (urlPath) => {
  let p = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  if (!p.startsWith(DIST) || !existsSync(p)) p = path.join(DIST, "index.html");
  return { body: readFileSync(p), type: MIME[path.extname(p)] ?? "application/octet-stream" };
};
const web = createServer((req, res) => {
  const f = distFile(req.url.split("?")[0]);
  res.setHeader("content-type", f.type);
  res.end(f.body);
});

async function waitFor(page, fn, label, timeoutMs = 20_000, arg) {
  try { await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 100 }); return true; } catch { ok(false, `timed out: ${label}`); return false; }
}

async function main() {
  if (!existsSync(path.join(DIST, "index.html"))) throw new Error("no dist/: run npm run build first");
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64url");
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
  await startWrangler(pub);
  await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));
  const { chromium } = await import(pathToFileURL(PW).href);
  // the dev page is "https://scrap.andrenijman.com" (routed) talking to a relay on
  // 127.0.0.1: Chromium's local network access checks would block that
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults"] });
  const errors = [];
  const watch = (page, name) => {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load/.test(m.text())) errors.push(`${name} console: ${m.text().slice(0, 200)}`); });
  };
  const open = async (name) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    watch(page, name);
    await page.goto(`http://127.0.0.1:${WEB_PORT}/?relay=ws://127.0.0.1:${RELAY_PORT}`);
    return page;
  };
  try {
    const host = await open("host");
    const guest = await open("guest");
    await host.click("#btn-online");
    await waitFor(host, () => document.querySelector("#lobby-info b")?.textContent?.length >= 4, "host gets a room code");
    const code = await host.textContent("#lobby-info b");
    await guest.click("#btn-join");
    await guest.fill("#join-code", code);
    await guest.click("#do-join");
    await waitFor(host, () => !document.getElementById("btn-lobby-ready").disabled, "ready enabled");
    for (const page of [host, guest]) await page.click("#btn-lobby-ready");
    for (const [name, page] of [["host", host], ["guest", guest]]) {
      await waitFor(page, () => { const b = document.getElementById("btn-lock"); return !b.classList.contains("hidden") && !b.disabled; }, `${name} build phase`);
      await page.evaluate(() => window.__dev.loadCart());
    }
    for (const page of [host, guest]) await page.click("#btn-lock");
    for (const [name, page] of [["host", host], ["guest", guest]]) {
      await waitFor(page, () => { const s = window.__dev.state(); return s.battleKind === "online" && s.mode === "test" && (s.sim?.tick ?? 0) > 30; }, `${name} reaches combat`, 30_000);
    }
    // the host drives forward, so the robots move and the dev has inputs to replay
    await host.keyboard.down("KeyW");
    await sleep(3000);
    const hostTickAtJoin = await host.evaluate(() => window.__dev.state().sim?.tick ?? 0);

    // the dev, through the admin page's link, mid-match
    const dev = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    watch(dev, "dev");
    let devPassAsked = 0;
    await dev.route("https://scrap.andrenijman.com/**", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/_guard/dev") {
        devPassAsked++;
        const { pass: p, exp } = await signDevPass(priv, { name: "Tester", host: "scrap.andrenijman.com" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dev: true, name: "TESTER", pass: p, exp }) });
      }
      if (u.pathname.startsWith("/_guard/")) return route.fulfill({ status: 404, body: "" });
      const f = distFile(u.pathname);
      return route.fulfill({ status: 200, contentType: f.type, body: f.body });
    });
    await dev.goto(`https://scrap.andrenijman.com/?relay=ws://127.0.0.1:${RELAY_PORT}&join=${encodeURIComponent(code)}`);

    const banner = (page) => page.waitForFunction(() => {
      const b = document.getElementById("dev-joined-banner");
      return !!b && b.textContent === "DEV TESTER HAS JOINED" && getComputedStyle(b).opacity === "1";
    }, undefined, { timeout: 45_000, polling: 100 }).then(() => true, () => false); // wrangler dev answers slowly on a loaded machine
    const seen = await Promise.all([host, guest, dev].map(banner));
    const bannerAt = Date.now();
    for (const [i, name] of ["host", "guest", "dev"].entries()) ok(seen[i], `${name} shows "DEV TESTER HAS JOINED" in the middle of the screen`);
    ok(devPassAsked >= 1, "the dev page asked /_guard/dev for its pass");
    await host.screenshot({ path: path.join(SHOTS, "devjoin-banner-host.png") });
    await dev.screenshot({ path: path.join(SHOTS, "devjoin-banner-dev.png") });

    // the game adjusted: the dev spectates its own copy of the match, caught up and running
    await waitFor(dev, () => { const s = window.__dev.state(); return s.spectating && s.mode === "test" && s.spec?.caughtUp && (s.sim?.tick ?? 0) > 0; }, "dev spectator catches up with the match", 60_000);
    const d1 = await dev.evaluate(() => window.__dev.state());
    await sleep(1500);
    const d2 = await dev.evaluate(() => window.__dev.state());
    const h2 = await host.evaluate(() => window.__dev.state());
    const g2 = await guest.evaluate(() => window.__dev.state());
    ok(d1.spectating && d1.battleKind === "online" && d1.sim?.a?.pos && d1.sim?.b?.pos, "dev is spectating with both robots in its sim");
    ok(d2.sim.tick > d1.sim.tick + 30 && d2.sim.tick > hostTickAtJoin, `dev's sim runs live (tick ${d1.sim.tick} -> ${d2.sim.tick}; host at ${h2.sim?.tick}, joined at ${hostTickAtJoin})`);
    const gap = Math.hypot(d2.sim.a.pos.x - h2.sim.a.pos.x, d2.sim.a.pos.y - h2.sim.a.pos.y);
    console.log(`info: host's robot in the dev's sim vs the host's own: ${gap.toFixed(2)} m apart (ticks ${d2.sim.tick} / ${h2.sim.tick})`);
    // robot 1 runs on the host's relayed inputs, as in the guest's sim (the
    // host's own sim applies its keys directly; its frames can lag, see the report)
    ok(d2.sim.a.defeated || d2.sim.a.inputs?.forward === g2.sim?.a?.inputs?.forward,
      `robot 1 in the dev's sim has the host's relayed input, as the guest has it (dev ${JSON.stringify(d2.sim.a.inputs)}, guest ${JSON.stringify(g2.sim?.a?.inputs)})`);
    const info = await dev.textContent("#lobby-info");
    ok(/^SPECTATING ROOM/.test(info ?? ""), `dev's bar: "${info}"`);
    ok(await dev.evaluate(() => document.getElementById("btn-lobby-ready").classList.contains("hidden")), "no READY button for a spectator");
    await sleep(Math.max(0, bannerAt + 4600 - Date.now())); // the banner fades after 4 s
    await dev.screenshot({ path: path.join(SHOTS, "devjoin-spectating-dev.png") });
    await host.screenshot({ path: path.join(SHOTS, "devjoin-combat-host.png") });

    // the admin page's live view: who, and where
    const players = await Promise.all([host, guest, dev].map((p) => p.evaluate(() => window.__gamesPlayer)));
    ok(JSON.stringify(players) === JSON.stringify([{ name: "Player 1", room: code }, { name: "Player 2", room: code }, { name: "Spectator", room: code }]),
      `window.__gamesPlayer on each page (${JSON.stringify(players)})`);
    const search = await dev.evaluate(() => location.search);
    ok(!/join=/.test(search) && /relay=/.test(search), `?join= dropped after the attempt (${search})`);
    await host.keyboard.up("KeyW");
    ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  } finally {
    await browser.close();
  }
}

process.on("SIGINT", () => { stop(); process.exit(130); });
const guard = setTimeout(() => { console.log("FAIL: smoke hung"); stop(); process.exit(1); }, 240_000);
try {
  await main();
} catch (e) {
  fail++;
  console.log("FAIL:", e.message);
} finally {
  clearTimeout(guard);
  web.close();
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
