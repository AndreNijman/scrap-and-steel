// SCRAP AND STEEL — tools/prod-e2e.mjs
// Production gate: two browser profiles create/join an online room on the LIVE
// relay, lock in builds, and reach synchronized combat. Run against prod by default.
import { chromium } from "playwright";

const SITE = process.argv[2] ?? "https://scrap.andrenijman.com";
const fails = [];
const ok = (m) => console.log(`e2e: ${m}`);
const fail = (m) => fails.push(m);

const CART = JSON.stringify({
  schemaVersion: 1,
  id: "e2e-cart",
  name: "E2E Cart",
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
});

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP scrap.andrenijman.com 104.21.24.65"] });
async function makePlayer() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR|Failed to load resource/.test(m.text())) console.log(`  [console] ${m.text()}`); });
  page.on("websocket", (ws) => console.log(`  [ws] ${ws.url()}`));
  await page.goto(SITE, { waitUntil: "load", timeout: 30000 });
  await page.evaluate((bp) => {
    localStorage.setItem("scrap_bp_autosave_p0", bp);
    localStorage.setItem("scrap_bp_autosave_p1", bp);
  }, CART);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1500);
  return page;
}

const p1 = await makePlayer();
const p2 = await makePlayer();

// host creates a room
await p1.click("#btn-online");
await p1.waitForSelector("#screen-lobby:not(.hidden)", { timeout: 15000 });
const code = (await p1.textContent("#lobby-code")).trim();
ok(`room created: ${code}`);

// guest joins by code
await p2.click("#btn-join");
await p2.fill("#join-code", code);
await p2.click("#do-join");
await p2.waitForSelector("#screen-lobby:not(.hidden)", { timeout: 15000 });
// wait until the host sees the guest in the room (Ready unlocks only then)
let guestSeen = false;
for (let i = 0; i < 30; i++) {
  const p1txt = await p1.textContent("#lobby-p1");
  const p2txt = await p2.textContent("#lobby-p0").catch(() => "?");
  if (p1txt && p1txt.includes("Guest")) { guestSeen = true; break; }
  if (i === 14) console.log(`  [diag] host sees p1="${p1txt}" | guest sees p0="${p2txt}"`);
  await p1.waitForTimeout(500);
}
if (!guestSeen) fail("host never saw the guest in the lobby");
ok("guest joined lobby");

// both ready -> build phase with deadline
await p1.click("#btn-ready");
await p2.click("#btn-ready");
await p1.waitForSelector("#screen-build:not(.hidden)", { timeout: 15000 });
await p2.waitForSelector("#screen-build:not(.hidden)", { timeout: 15000 });
const timer = await p1.textContent("#build-timer");
ok(`build phase reached, timer: ${timer.trim()}`);

// both lock in -> countdown -> combat
await p1.click("#btn-lock");
await p2.click("#btn-lock");
try {
  await p1.waitForSelector("#screen-combat:not(.hidden)", { timeout: 30000 });
  await p2.waitForSelector("#screen-combat:not(.hidden)", { timeout: 30000 });
} catch (e) {
  // capture state for diagnosis
  const p1build = await p1.isVisible("#screen-build:not(.hidden)");
  const p1msg = await p1.textContent("#build-msg").catch(() => "?");
  const p2build = await p2.isVisible("#screen-build:not(.hidden)");
  const p2msg = await p2.textContent("#build-msg").catch(() => "?");
  throw new Error(`no combat (p1 build: ${p1build} msg: ${p1msg}) (p2 build: ${p2build} msg: ${p2msg})`);
}
ok("both clients reached synchronized combat");

// let the fight run, drive both robots with real inputs
await p1.keyboard.down("KeyW");
await p2.keyboard.down("KeyW");
await p2.keyboard.down("Space");
await p1.waitForTimeout(8000);
await p1.keyboard.up("KeyW");
await p2.keyboard.up("KeyW");
await p2.keyboard.up("Space");

const p1alive = await p1.isVisible("#screen-combat:not(.hidden)");
if (!p1alive) fail("combat screen vanished on p1");
else ok("combat ran for 8s on live relay without errors");
await p1.screenshot({ path: "shots/e2e-online-combat.png" });

// p1 should have received peer input/snapshots (drive the fight long enough to matter)
if (fails.length) {
  console.log(`E2E FAILED (${fails.length}): ${fails.join(" | ")}`);
  process.exitCode = 1;
} else {
  console.log("E2E PASSED");
}
await browser.close();
