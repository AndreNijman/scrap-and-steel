// SCRAP AND STEEL — tools/smoke.mjs
// Browser smoke test: boots the game, enters solo build, places parts, starts a
// test, ends it, locks in, and lets the AI fight run. Fails on console errors.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer((req, res) => {
  let p = join(DIST, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(p)) p = join(DIST, "index.html");
  res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5199, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  // relay-offline fetch failures are expected in the smoke environment
  if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`);
});


// poll-based wait: Playwright's rAF-driven waitForSelector starves behind the
// game's render loop in headless/software-GL environments
async function waitUntil(page, fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(fn)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  console.error(errors.join("\n"));
  process.exitCode = 1;
};
const ok = (msg) => console.log(`smoke: ${msg}`);

try {
  await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // rapier wasm init
  if (errors.length) throw new Error(`boot errors: ${errors.join("; ")}`);
  ok("booted, no console errors");

  // menu is visible
  await waitUntil(page, () => !document.getElementById("screen-menu").classList.contains("hidden"), 5000, "menu");
  ok("menu visible");

  // solo mode
  await page.click("#btn-solo");
  await waitUntil(page, () => !document.getElementById("screen-build").classList.contains("hidden"), 5000, "build");
  ok("build screen visible");

  // pick a part and place it by clicking the viewport
  await page.click('#bin-items .bin-item:first-child');
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
  const partsText = await page.textContent("#build-parts");
  if (!/1\/120/.test(partsText)) throw new Error(`part not placed (${partsText})`);
  ok("part placed via click");

  // undo / redo
  await page.click("#btn-undo");
  await page.waitForTimeout(200);
  if (!/0\/120/.test(await page.textContent("#build-parts"))) throw new Error("undo failed");
  await page.click("#btn-redo");
  await page.waitForTimeout(200);
  if (!/1\/120/.test(await page.textContent("#build-parts"))) throw new Error("redo failed");
  ok("undo/redo works");

  // build a minimal drivable cart via the autosave slot (a known-good build)
  const cart = {
    schemaVersion: 1,
    id: "smoke-cart",
    name: "Smoke Cart",
    parts: [
      { id: "core", defId: "control_core", pos: [0, 0, 0], rot: 0 },
      { id: "bat", defId: "battery_hidisc", pos: [0, 1, 0], rot: 0 },
      { id: "motL", defId: "motor_torque", pos: [-1, 0, 0], rot: 0 },
      { id: "motR", defId: "motor_torque", pos: [1, 0, 0], rot: 0 },
      { id: "whlL", defId: "wheel_rubber", pos: [-2, 0, 0], rot: 0 },
      { id: "whlR", defId: "wheel_rubber", pos: [2, 0, 0], rot: 0 },
    ],
    wires: [
      { id: "w1", from: "bat", to: "core", gauge: "heavy" },
      { id: "w2", from: "bat", to: "motL", gauge: "heavy" },
      { id: "w3", from: "bat", to: "motR", gauge: "heavy" },
    ],
    bindings: [
      { channel: "throttle", targetPartId: "motL" },
      { channel: "throttle", targetPartId: "motR" },
      { channel: "steer", targetPartId: "motL" },
      { channel: "steer", targetPartId: "motR" },
    ],
  };
  await page.evaluate((bp) => {
    localStorage.setItem("scrap_bp_autosave_p1", bp);
  }, JSON.stringify(cart));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.click("#btn-solo");
  await page.waitForTimeout(500);
  const loaded = await page.textContent("#build-parts");
  ok(`autosave loaded: ${loaded}`);

  // Test Bay: start test, let physics run, end test — blueprint must restore exactly
  const bpBefore = await page.evaluate(() => localStorage.getItem("scrap_bp_autosave_p1"));
  await page.click("#btn-test");
  await page.waitForTimeout(3000); // let the cart drive around the test arena
  await page.click("#btn-test"); // End Test
  await page.waitForTimeout(400);
  const bpAfter = await page.evaluate(() => localStorage.getItem("scrap_bp_autosave_p1"));
  if (bpBefore !== bpAfter) throw new Error("Test Bay leaked runtime state into the blueprint");
  ok("test bay start/end restores blueprint exactly");
  await page.screenshot({ path: "shots/smoke-testbay.png" });

  // lock in -> combat starts with countdown
  await page.click("#btn-lock");
  await waitUntil(page, () => !document.getElementById("screen-combat").classList.contains("hidden"), 15000, "combat");
  ok("combat screen reached");

  // wait for the AI fight to produce a result; drive into the enemy meanwhile
  await page.keyboard.down("KeyW");
  await page.keyboard.down("Space");
  try {
    await waitUntil(page, () => !document.getElementById("result-overlay").classList.contains("hidden"), 300000, "result");
    const banner = await page.textContent("#result-banner");
    const reason = await page.textContent("#result-reason");
    ok(`combat resolved: ${banner} — ${reason}`);
  } catch (e) {
    const st = await page.evaluate(() => ({
      overlay: document.getElementById("result-overlay").className,
      timer: document.getElementById("combat-timer").textContent,
      p0: document.getElementById("status-p0").textContent,
      p1: document.getElementById("status-p1").textContent,
    }));
    fail(`result never shown: ${e.message.split("\n")[0]} | overlay="${st.overlay}" timer=${st.timer} | YOU[${st.p0}] AI[${st.p1}]`);
  }
  await page.keyboard.up("KeyW");
  await page.keyboard.up("Space");
  await page.screenshot({ path: "shots/smoke-combat.png" });
  if (errors.length) throw new Error(`runtime errors: ${errors.slice(0, 5).join("; ")}`);
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
