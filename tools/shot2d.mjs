// SCRAP & STEEL — 2D debug screenshots
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
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load/.test(m.text())) console.log("CONSOLE:", m.text()); });
await page.goto("http://localhost:5199/", { waitUntil: "load" });
await page.waitForTimeout(3000);
await page.screenshot({ path: "shots/2d-menu.png" });
await page.click("#btn-workshop");
await page.waitForTimeout(1500);
// place a few parts via the bin
await page.click('#bin-tabs button:nth-child(2)'); // motion
await page.waitForTimeout(200);
const items = await page.$$("#bin-items .bin-item");
console.log("bin items in MOTION:", items.length);
await page.screenshot({ path: "shots/2d-workshop.png" });
// load the TANK blueprint by generating one in-page through an exported hook:
// simplest — expose window.__botBp from the game (add in main). Skip if absent.
const hasHook = await page.evaluate(() => typeof window.__spawnBotBlueprint === "function");
console.log("bot blueprint hook:", hasHook);
await browser.close();
server.close();
console.log("done");
