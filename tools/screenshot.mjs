// SCRAP AND STEEL — tools/screenshot.mjs
// Captures a portal thumbnail (1000x525): solo match mid-fight with HUD.
import { chromium } from "playwright";

const SITE = process.argv[2] ?? "http://localhost:5199";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(SITE, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(2500);

// load a good-looking build and fight the AI
const BOT = await import("node:fs").then((fs) => fs.readFileSync(new URL("./bot-bp.json", import.meta.url), "utf8"));
await page.evaluate((bp) => {
  localStorage.setItem("scrap_bp_autosave_p1", bp);
}, BOT);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1500);
await page.click("#btn-solo");
await page.waitForTimeout(400);
await page.click("#btn-lock");
await page.waitForSelector("#screen-combat:not(.hidden)", { timeout: 15000 });
// fight: drive at the AI with the spinner up
await page.keyboard.down("KeyW");
await page.keyboard.down("Space");
await page.waitForTimeout(9000);
// camera framing: zoom out slightly for the shot
await page.mouse.wheel(0, 120);
await page.waitForTimeout(800);
await page.screenshot({ path: "shots/portal.png", clip: { x: 140, y: 120, width: 1000, height: 525 } });
await browser.close();
console.log("screenshot saved to shots/portal.png");
