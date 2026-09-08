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
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.split("\n")[0]));
await page.goto("http://localhost:5199/", { waitUntil: "load" });
await page.waitForTimeout(2500);
await page.click("#btn-workshop");
await page.waitForTimeout(400);
await page.evaluate(() => window.__dev.loadCart());
await page.click("#btn-test");
await page.waitForTimeout(600);
const st0 = await page.evaluate(() => window.__dev.state().sim);
console.log("t0:", JSON.stringify(st0?.a?.inputs), "tick", st0?.tick);
await page.keyboard.down("KeyW");
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => window.__dev.state().sim);
  console.log(`${i + 1}s tick=${st?.tick} x=${st?.a?.pos?.x?.toFixed(2)} inputs=${JSON.stringify(st?.a?.inputs)} charge=${st?.a?.charge}`);
}
await page.keyboard.up("KeyW");
await browser.close(); server.close();
