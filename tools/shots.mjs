import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
const DIST = "/var/home/andre/Projects/site/games.andrenijman.com/scraps/dist";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  let p = join(DIST, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(p)) p = join(DIST, "index.html");
  res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5199, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5199/", { waitUntil: "load" });
await page.waitForTimeout(4000);
await page.screenshot({ path: "shots/look-menu.png" });
const BOT = await import("node:fs").then(fs => fs.readFileSync("/var/home/andre/Projects/site/games.andrenijman.com/scraps/tools/bot-bp.json", "utf8"));
await page.evaluate((bp) => { localStorage.setItem("scrap_bp_autosave_p1", bp); }, BOT);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2500);
await page.click("#btn-solo");
await page.waitForTimeout(600);
// place a part to show the editor
await page.click('#bin-items .bin-item:first-child');
await page.mouse.click(700, 420);
await page.waitForTimeout(300);
await page.screenshot({ path: "shots/look-build.png" });
await page.click("#btn-lock");
await page.waitForSelector("#screen-combat", { state: "attached", timeout: 15000 }).catch(() => {});
await waitCombat();
async function waitCombat() {
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !document.getElementById("screen-combat").classList.contains("hidden"))) break;
    await page.waitForTimeout(500);
  }
}
await page.waitForTimeout(9000); // fight + spin-up
await page.keyboard.down("KeyW"); await page.keyboard.down("Space");
await page.waitForTimeout(9000);
await page.screenshot({ path: "shots/look-combat.png" });
await browser.close(); server.close();
console.log("shots saved");
