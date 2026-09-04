// SCRAP & STEEL — 2D gameplay smoke test
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
const DIST = "/var/home/andre/Projects/site/games.andrenijman.com/scraps/dist";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  let p = join(DIST, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(p)) p = join(DIST, "index.html");
  res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5199, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let failed = false;
page.on("pageerror", (e) => { console.log("PAGEERROR:", (e.stack ?? e.message).split("\n").slice(0, 5).join(" | ")); failed = true; });
page.on("console", (m) => {
  const t = m.text();
  if (/net::ERR|Failed to load/.test(t)) return;
  console.log("[" + m.type() + "]", t.slice(0, 300));
  if (m.type() === "error") failed = true;
});
await page.goto("http://localhost:5199/", { waitUntil: "load" });
await page.waitForTimeout(3000);

// 1. load the tank blueprint as the player machine
console.log("dev hook type:", await page.evaluate(() => typeof window.__dev));
console.log("menu hidden?", await page.evaluate(() => document.getElementById("screen-menu")?.className));
console.log("module err?", await page.evaluate(() => window.__err ?? "none"));
await page.evaluate(() => window.__dev.loadBot("tank"));
await page.click("#btn-workshop");
await page.waitForTimeout(800);
const st1 = await page.evaluate(() => window.__dev.state());
console.log("checklist:", await page.evaluate(() => document.getElementById("diag-body").textContent.replace(/\s+/g, " | ")));
console.log("workshop state:", JSON.stringify(st1));
await page.screenshot({ path: "shots/2d-tank-build.png" });

// 2. test mode (no opponent): press W, robot should drive right
await page.click("#btn-test");
await page.waitForTimeout(500);
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
const stDrive = await page.evaluate(() => window.__dev.state().sim);
console.log("after drive:", JSON.stringify(stDrive?.a));
await page.screenshot({ path: "shots/2d-test-drive.png" });
await page.keyboard.up("KeyW");
const drove = stDrive && stDrive.a && stDrive.a.pos && stDrive.a.pos.x > 2;
console.log(drove ? "DRIVE OK" : "DRIVE FAIL (robot did not move)");

// 3. quick battle vs scout
await page.evaluate(() => window.__dev.startBotBattle("scout"));
await page.waitForTimeout(1000);
await page.keyboard.down("KeyW");
await page.keyboard.down("Space");
let outcome = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => { const d = window.__dev.state(); return { sim: d.sim, err: window.__err ?? null }; });
  if (st.err && !errShown) { console.log("FRAME ERROR:", st.err.split("\n").slice(0,5).join(" | ")); errShown = true; }
  const sim = st.sim;
  if (i % 10 === 0 || sim?.outcome) console.log(`${i}s out=${JSON.stringify(sim?.outcome)} A=(${sim?.a?.pos?.x?.toFixed(1)},${sim?.a?.pos?.y?.toFixed(1)}) lostA=${sim?.a?.partsLost} B=(${sim?.b?.pos?.x?.toFixed(1)},${sim?.b?.pos?.y?.toFixed(1)}) lostB=${sim?.b?.partsLost} proj=${sim?.projectiles} mp=${JSON.stringify(sim?.a?.motorPowers)} tp=${JSON.stringify(sim?.a?.trackPowered)} err=${st.err ? 'YES' : 'no'}`);
  if (sim?.outcome) { outcome = sim.outcome; break; }
}
await page.screenshot({ path: "shots/2d-battle.png" });
console.log(outcome ? `BATTLE OUTCOME: ${JSON.stringify(outcome)}` : "BATTLE DID NOT RESOLVE IN 60s");
await browser.close();
server.close();
if (failed) { console.log("SMOKE FAILED (page errors)"); process.exit(1); }
console.log(outcome ? "SMOKE PASSED" : "SMOKE INCOMPLETE");
