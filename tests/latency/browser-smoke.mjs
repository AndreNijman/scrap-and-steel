// Browser smoke for the latency UI: the built game in two headless Chromium
// pages against wrangler dev. The host creates a room, the guest joins with
// the code, the lobby bar shows the room's region and ping, both ready and
// lock in, and in combat the HUD shows "NN ms". Fails on any page error.
//   npm run build && node tests/latency/browser-smoke.mjs
// Ports: relay 8872 (inspector 9372), NetLog stub 8873 (9373), static 8874.
// PLAYWRIGHT_CORE and CHROME pick the browser; screenshots go to tests/latency/.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = path.join(ROOT, "dist");
const PW = process.env.PLAYWRIGHT_CORE || "/var/home/andre/Projects/site/games.andrenijman.com/river-flume/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME || "/var/home/andre/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const RELAY_PORT = 8872, STUB_PORT = 8873, WEB_PORT = 8874;
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
async function startWrangler() {
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  const bin = process.env.WRANGLER || (existsSync(local) ? local : "npx");
  const pre = bin === "npx" ? ["wrangler"] : [];
  registry = mkdtempSync(path.join(tmpdir(), "scrap-registry-"));
  const run = (args) => servers.push(spawn(bin, [...pre, ...args], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, WRANGLER_REGISTRY_PATH: registry } }));
  run(["dev", "-c", "tests/latency/netlog-stub.jsonc", "--port", String(STUB_PORT), "--inspector-port", "9373", "--ip", "127.0.0.1"]);
  run(["dev", "--port", String(RELAY_PORT), "--inspector-port", "9372", "--ip", "127.0.0.1", "--var", "DEV_COLO:FRA"]);
  if (!(await up(`http://127.0.0.1:${STUB_PORT}/`)) || !(await up(`http://127.0.0.1:${RELAY_PORT}/health`))) throw new Error("wrangler dev did not come up");
  await sleep(1500);
}
function stop() {
  for (const p of servers) try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* in use */ }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const web = createServer((req, res) => {
  const rel = req.url.split("?")[0];
  let p = path.join(DIST, rel === "/" ? "index.html" : rel);
  if (!p.startsWith(DIST) || !existsSync(p)) p = path.join(DIST, "index.html");
  res.setHeader("content-type", MIME[path.extname(p)] ?? "application/octet-stream");
  res.end(readFileSync(p));
});

async function waitFor(page, fn, label, timeoutMs = 20_000, arg) {
  try { await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 250 }); return true; } catch { ok(false, `timed out: ${label}`); return false; }
}

async function main() {
  if (!existsSync(path.join(DIST, "index.html"))) throw new Error("no dist/: run npm run build first");
  await startWrangler();
  await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));
  const { chromium } = await import(pathToFileURL(PW).href);
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const open = async (name) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load/.test(m.text())) errors.push(`${name} console: ${m.text().slice(0, 200)}`); });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/?relay=ws://127.0.0.1:${RELAY_PORT}`);
    return page;
  };
  try {
    const host = await open("host");
    const guest = await open("guest");
    await host.click("#btn-online");
    await waitFor(host, () => document.querySelector("#lobby-info b")?.textContent?.length >= 4, "host gets a room code");
    const code = await host.textContent("#lobby-info b");
    ok(/^[A-Z0-9]{4,6}$/.test(code ?? ""), `room code ${code}`);
    await guest.click("#btn-join");
    await guest.fill("#join-code", code);
    await guest.click("#do-join");

    const labelRe = "^Western Europe · \\d+ ms$";
    for (const [name, page] of [["host", host], ["guest", guest]]) {
      await waitFor(page, (re) => { const el = document.getElementById("lobby-region"); return !!el && !el.classList.contains("hidden") && new RegExp(re).test(el.textContent ?? ""); }, `${name} lobby region label`, 20_000, labelRe);
      const label = await page.textContent("#lobby-region");
      ok(new RegExp(labelRe).test(label ?? ""), `${name} lobby shows "${label}"`);
      ok(await page.evaluate(() => document.getElementById("hud-ping").classList.contains("hidden")), `${name} HUD ping hidden in the lobby`);
    }
    await waitFor(host, () => !document.getElementById("btn-lobby-ready").disabled, "ready enabled");
    await host.screenshot({ path: path.join(HERE, "smoke-lobby-host.png") });
    await guest.screenshot({ path: path.join(HERE, "smoke-lobby-guest.png") });

    for (const page of [host, guest]) await page.click("#btn-lobby-ready");
    for (const [name, page] of [["host", host], ["guest", guest]]) {
      await waitFor(page, () => { const b = document.getElementById("btn-lock"); return !b.classList.contains("hidden") && !b.disabled; }, `${name} build phase`);
      await page.evaluate(() => window.__dev.loadCart());
    }
    for (const page of [host, guest]) await page.click("#btn-lock");
    for (const [name, page] of [["host", host], ["guest", guest]]) {
      await waitFor(page, () => { const s = window.__dev.state(); return s.battleKind === "online" && s.mode === "test" && (s.sim?.tick ?? 0) > 30; }, `${name} reaches combat`, 30_000);
      await waitFor(page, () => { const el = document.getElementById("hud-ping"); return !el.classList.contains("hidden") && /^\d+ ms$/.test(el.textContent ?? ""); }, `${name} HUD ping`, 10_000);
      const hud = await page.evaluate(() => { const el = document.getElementById("hud-ping"); return { text: el.textContent, hidden: el.classList.contains("hidden"), warn: el.classList.contains("warn"), bad: el.classList.contains("bad") }; });
      const ms = Number(/^(\d+) ms$/.exec(hud.text ?? "")?.[1] ?? NaN);
      ok(!hud.hidden && Number.isFinite(ms), `${name} HUD shows "${hud.text}"`);
      ok(hud.warn === (ms >= 120 && ms < 200) && hud.bad === ms >= 200, `${name} HUD class matches ${ms} ms (warn ${hud.warn}, bad ${hud.bad})`);
      await page.screenshot({ path: path.join(HERE, `smoke-combat-${name}.png`) });
    }
    ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  } finally {
    await browser.close();
  }
}

process.on("SIGINT", () => { stop(); process.exit(130); });
const guard = setTimeout(() => { console.log("FAIL: smoke hung"); stop(); process.exit(1); }, 180_000);
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
