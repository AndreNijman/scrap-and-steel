// SCRAP & STEEL — final screenshots for the portal + review
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
await page.goto("http://localhost:5199/", { waitUntil: "load" });
await page.waitForTimeout(3500);
await page.screenshot({ path: "shots/menu.png" });
// workshop with the tank loaded
await page.evaluate(() => window.__dev.loadBot("tank"));
await page.click("#btn-workshop");
await page.waitForTimeout(800);
await page.screenshot({ path: "shots/workshop.png" });
// battle
await page.evaluate(() => window.__dev.startBotBattle("scout"));
await page.waitForTimeout(1500);
await page.keyboard.down("KeyW");
await page.keyboard.down("Space");
await page.waitForTimeout(12000);
await page.screenshot({ path: "shots/battle.png" });
await browser.close();
server.close();
console.log("shots saved");
