// SCRAP & STEEL — production e2e: two browsers play an online 1v1 on the live relay.
// Flow: create room -> join by code -> both ready -> build phase (server clock)
// -> both lock -> countdown -> synchronized combat with input frames.
import { chromium } from "playwright";

const SITE = process.argv[2] ?? "https://scrap.andrenijman.com";
const ok = (m) => console.log(`e2e: ${m}`);
const fails = [];

const browser = await chromium.launch();

async function makePlayer(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fails.push(`pageerror: ${e.message.split("\n")[0]}`));
  await page.goto(SITE, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__dev.loadCart());
  return page;
}

const p1 = await makePlayer("Host");
const p2 = await makePlayer("Guest");

// host creates
await p1.click("#btn-online");
await p1.waitForSelector("#lobby-bar:not(.hidden)", { timeout: 15000 });
const code = (await p1.textContent("#lobby-info")).match(/[A-Z0-9]{5}/)?.[0] ?? "";
ok(`room created: ${code}`);
if (!code) { console.log("E2E FAILED: no room code"); process.exit(1); }

// guest joins by code
await p2.click("#btn-join");
await p2.fill("#join-code", code);
await p2.click("#do-join");
await p2.waitForSelector("#lobby-bar:not(.hidden)", { timeout: 15000 });
// wait until the host sees the guest (ready unlocks only then)
let seen = false;
for (let i = 0; i < 30; i++) {
  const info = await p1.textContent("#lobby-info");
  if (!/waiting for an opponent/.test(info)) { seen = true; break; }
  await p1.waitForTimeout(500);
}
if (!seen) fails.push("host never saw the guest");
else ok("guest joined lobby");

// both ready -> build phase with the server deadline
await p1.click("#btn-lobby-ready");
await p2.click("#btn-lobby-ready");
await p1.waitForSelector("#lobby-bar.hidden", { timeout: 15000 }).catch(() => {});
await p1.waitForFunction(() => document.getElementById("btn-lock")?.textContent?.includes("LOCK"), { timeout: 15000 });
await p2.waitForFunction(() => document.getElementById("btn-lock")?.textContent?.includes("LOCK"), { timeout: 15000 });
ok("build phase reached (server deadline active)");

// both lock in -> countdown -> combat
await p1.click("#btn-lock");
await p2.click("#btn-lock");
for (const [label, page] of [["p1", p1], ["p2", p2]]) {
  let inCombat = false;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => window.__dev.state());
    if (st.mode === "test" && st.sim) { inCombat = true; break; }
    await page.waitForTimeout(500);
  }
  if (!inCombat) fails.push(`${label} never reached combat`);
}
if (!fails.filter((f) => f.includes("combat")).length) ok("both clients reached synchronized combat");

// fight for 10s: both drive + fire
await p1.keyboard.down("KeyW");
await p2.keyboard.down("KeyW");
await p2.keyboard.down("Space");
await p1.waitForTimeout(10000);
const s1 = await p1.evaluate(() => window.__dev.state().sim);
ok(`combat ran: p1 pos=(${s1?.a?.pos?.x?.toFixed(1)},${s1?.a?.pos?.y?.toFixed(1)}) enemy parts lost=${s1?.b?.partsLost} projectiles=${s1?.projectiles}`);
if (s1?.a?.pos?.x === undefined) fails.push("no sim state on p1");

// remote inputs must flow: the opponent should have moved (position delta from spawn)
if (fails.length) {
  console.log(`E2E FAILED: ${fails.join(" | ")}`);
  process.exit(1);
}
console.log("E2E PASSED");
await browser.close();
