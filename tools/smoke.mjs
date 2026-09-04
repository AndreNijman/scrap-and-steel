// SCRAP & STEEL — CI smoke test (2D game)
// Boots the built game, enters the workshop, places parts, wires, runs a
// TEST-mode drive, then fights a bot battle to a resolution.
import { chromium } from "playwright";

const DIST = new URL("../dist", import.meta.url).pathname;
const { createServer } = await import("node:http");
const { readFileSync, existsSync } = await import("node:fs");
const { join, extname } = await import("node:path");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  let p = join(DIST, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(p)) p = join(DIST, "index.html");
  res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5199, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
let failed = false;
page.on("pageerror", (e) => { console.log("PAGEERROR:", (e.stack ?? e.message).split("\n").slice(0, 3).join(" | ")); failed = true; });
page.on("console", (m) => {
  const t = m.text();
  if (/net::ERR|Failed to load/.test(t)) return;
  if (m.type() === "error") { console.log("CONSOLE:", t.slice(0, 200)); failed = true; }
});

const ok = (msg) => console.log(`smoke: ${msg}`);
const fail = (msg) => { console.log(`SMOKE FAIL: ${msg}`); process.exitCode = 1; };
async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(fn)) return;
    await page.waitForTimeout(400);
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  await page.goto("http://localhost:5199/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  ok("booted");
  await page.click("#btn-workshop");
  await waitUntil(() => !document.getElementById("screen-game").classList.contains("hidden"), 5000, "workshop");
  ok("workshop visible");

  // place parts through the UI: motion -> wheel
  await page.click('#bin-tabs button[data-cat="motion"]');
  await page.waitForTimeout(200);
  await page.click('#bin-items .bin-item:nth-child(2)'); // medium wheel
  await page.mouse.click(560, 560);
  await page.mouse.click(640, 560);
  // structure -> blocks
  await page.click('#bin-tabs button[data-cat="structure"]');
  await page.waitForTimeout(200);
  await page.click('#bin-items .bin-item:nth-child(1)'); // steel block
  for (const x of [560, 600, 640]) await page.mouse.click(x, 500);
  const devType = await page.evaluate(() => typeof window.__dev);
  const bpShape = await page.evaluate(() => { const b = window.__dev.bp(); return { parts: b.parts.length, wires: b.wires.length, logic: b.logic.length }; });
  console.log("dev:", devType, JSON.stringify(bpShape));
  if (bpShape.parts < 1) throw new Error("no state");
  ok("parts placed via UI clicks");

  // programmatically finish a valid cart (wheels/motors/battery/controller + wires + logic)
  await page.evaluate(() => window.__dev.loadCart());
  const cartOk = await page.evaluate(() => {
    const b = window.__dev.bp();
    return b.parts.length >= 8 && b.wires.length >= 3 && b.logic.length >= 4;
  });
  if (!cartOk) throw new Error("cart assembly failed");
  ok("cart assembled (parts + wires + logic)");

  // TEST mode: drive right
  await page.click("#btn-test");
  await waitUntil(() => window.__dev.state().mode === "test", 5000, "test mode");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2000);
  const x1 = await page.evaluate(() => window.__dev.state().sim.a.pos.x);
  await page.keyboard.up("KeyW");
  ok(`test drive: robot at x=${x1?.toFixed(2)}`);

  // battle vs bot
  await page.evaluate(() => window.__dev.startBotBattle("berserker"));
  await waitUntil(() => window.__dev.state().mode === "test" && window.__dev.state().sim, 10000, "battle sim");
  await page.keyboard.down("KeyW");
  await page.keyboard.down("Space");
  let outcome = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__dev.state().sim);
    if (s?.outcome) { outcome = s.outcome; break; }
  }
  await page.keyboard.up("KeyW");
  await page.keyboard.up("Space");
  if (outcome) ok(`battle resolved: ${JSON.stringify(outcome)}`);
  else fail("battle did not resolve in 90s");
} catch (e) {
  fail(e.message.split("\n")[0]);
}
await browser.close();
server.close();
console.log(failed || process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
if (failed) process.exit(1);
