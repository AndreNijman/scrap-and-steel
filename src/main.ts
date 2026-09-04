// SCRAP & STEEL — main.ts
// Boot, menu, workshop (build/test), diagnostics, battles (bots + online 1v1).

import type { Blueprint, SavedBlueprint } from "./game/blueprint";
import { emptyBlueprint, cloneBlueprint, preflight, robotStats, portWorldPos, saveBlueprint, listSaved, deleteBlueprint, migrateBlueprint, uid, type PlacedPart } from "./game/blueprint";
import { part, CELL, CATEGORY_LIST, type Category } from "./game/parts";
import { Builder } from "./game/builder";
import { Simulation, TICK, type BotDriver } from "./game/sim";
import { ARENAS } from "./game/arena";
import { BOT_SPECS, DriverBot, type BotSpec } from "./game/bots";
import { RelayClient, packInputs, unpackInputs, resolveRelayUrl } from "./game/net";
import { WorldRenderer } from "./render/draw";
import { LogicEditor, targetOptions, NODE_DEFS } from "./ui/logicEditor";
import { initAudio, sfx, updateDriveSound, updateWeaponSound, stopLoops } from "./audio/sfx";

const $ = (id: string) => document.getElementById(id)!;

type Screen = "menu" | "game";
type Mode = "build" | "test";
type BattleKind = null | "bot" | "online";

const canvas = $("gl") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let screen: Screen = "menu";
let mode: Mode = "build";
let battleKind: BattleKind = null;
let bp: Blueprint = emptyBlueprint("MK-I PROTOTYPE");
let builder = new Builder(bp, {});
let renderer = new WorldRenderer();
let logicEditor: LogicEditor | null = null;
let sim: Simulation | null = null;
let input = { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 };
let keys = new Set<string>();
let selectedPartId: string | null = null;
let hoverPartId: string | null = null;
let diagMode = false;
let relay: RelayClient | null = null;
let mySlot = 0;
let isAuthority = true;
let roomCode: string | null = null;
let lobbySettings = { buildTimeSec: 420, budgetSp: 1500, partLimit: 120, arena: "scrapyard", combatLimitSec: 300, rematch: "rebuild" };
let combatDeadline = 0;
let botSpec: BotSpec | null = null;
let botDriver: BotDriver | null = null;
let opponentBp: Blueprint | null = null;
let testSnapshot: string | null = null;
let lastFrame = 0;
let acc = 0;
let resultShown = false;
let remoteInputs = [{ forward: 0, back: 0, fire: 0, aux: 0, turret: 0 }, { forward: 0, back: 0, fire: 0, aux: 0, turret: 0 }];
let powerHistory: number[] = [];
let cameraFollow = true;
let toastTimer = 0;

// =========================================================================
// boot

function boot() {
  $("lab-ver").textContent = "v1.0";
  bindMenu();
  bindGameUi();
  initAudioOnGesture();
  checkRelay();
  requestAnimationFrame(frame);
  window.addEventListener("resize", resize);
  resize();
  showScreen("menu");
}

function resize() {
  const wrap = $("viewport-wrap");
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  logicEditor?.resize();
  const mc = $("menu-canvas") as HTMLCanvasElement;
  mc.width = mc.clientWidth;
  mc.height = mc.clientHeight;
}

function initAudioOnGesture() {
  const unlock = () => { initAudio(); window.removeEventListener("pointerdown", unlock); };
  window.addEventListener("pointerdown", unlock);
}

function showScreen(s: Screen) {
  screen = s;
  $("screen-menu").classList.toggle("hidden", s !== "menu");
  $("screen-game").classList.toggle("hidden", s !== "game");
  if (s === "game") resize();
}

function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  toastTimer = 2.4;
}

function checkRelay() {
  const el = $("menu-relay");
  fetch(`${resolveRelayUrl().replace(/^ws/, "http")}/health`, { signal: AbortSignal.timeout(4000) })
    .then((r) => {
      el.textContent = r.ok ? "RELAY ONLINE — matchmaking ready" : "RELAY ERROR";
      el.classList.add("ok");
    })
    .catch(() => {
      el.textContent = "RELAY OFFLINE — solo play still works";
    });
}

// =========================================================================
// menu

function drawMenuBg() {
  const mc = $("menu-canvas") as HTMLCanvasElement;
  const g = mc.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = "#10141a";
  g.fillRect(0, 0, mc.width, mc.height);
  const z = 40;
  // scattered components + a partially built robot silhouette
  const t = performance.now() / 1000;
  const items: [string, number, number][] = [
    ["motor_torque", 0.16, 0.72], ["battery_pack", 0.72, 0.74], ["wheel_large", 0.3, 0.84],
    ["wheel_medium", 0.42, 0.86], ["steel_block", 0.62, 0.8], ["capacitor", 0.85, 0.68],
    ["gun_barrel_s", 0.5, 0.78], ["dist_board", 0.24, 0.62], ["sen_radar", 0.8, 0.8],
    ["arm_heavy", 0.1, 0.5], ["hinge_block", 0.66, 0.6], ["heatsink", 0.36, 0.66],
  ];
  void t;
  g.globalAlpha = 0.9;
  for (const [def, fx, fy] of items) {
    import("./render/sprites").then(({ getSprite, ART }) => {
      void ART;
      const d = part(def);
      const s = getSprite(def, d.w, d.h);
      g.drawImage(s, mc.width * fx, mc.height * fy, d.w * z, d.h * z);
    });
  }
  g.globalAlpha = 1;
  // partial robot chassis
  g.fillStyle = "#161b22";
  g.fillRect(mc.width * 0.4, mc.height * 0.34, 220, 120);
  g.strokeStyle = "#2a333e";
  g.strokeRect(mc.width * 0.4, mc.height * 0.34, 220, 120);
}

function bindMenu() {
  $("btn-workshop").onclick = () => { sfx.uiClick(); enterWorkshop(); };
  $("btn-quick").onclick = () => { sfx.uiClick(); startBotBattle(); };
  $("btn-online").onclick = () => { sfx.uiClick(); connectOnline("create=1"); };
  $("btn-join").onclick = () => { sfx.uiClick(); promptJoin(); };
  $("btn-help").onclick = () => { sfx.uiClick(); showHelp(); };
  drawMenuBg();
  setInterval(() => { if (screen === "menu") drawMenuBg(); }, 2000);
}

function showHelp() {
  openModal(`
    <h3>FIELD MANUAL</h3>
    <ul>
      <li><b>BUILD:</b> pick a category, click parts, drag them onto the grid. R rotates, right-click removes, C/V copies and pastes.</li>
      <li><b>WIRE:</b> switch to WIRE mode. Click a port (small circles on part edges), then click another port. Batteries OUTPUT power; motors, weapons and sensors have INPUT ports. No wire = no power.</li>
      <li><b>LOGIC:</b> the bottom panel is your robot's brain. Add INPUT nodes (keys, sensors), MATH/LOGIC nodes, and OUTPUT nodes bound to specific motors and weapons. A starter drive: INPUT FORWARD − INPUT REVERSE → MOTOR POWER.</li>
      <li><b>TEST:</b> press TEST. Physics run. Drive with W/S, fire with SPACE, aux with SHIFT, turret Q/E. Break it, learn, press TEST again to rebuild instantly.</li>
      <li><b>DIAG:</b> diagnostic mode shows wire current flow and lets you click any component for live readouts.</li>
      <li><b>BATTLE:</b> a robot is disabled when it loses its controller, its mobility AND its weapons, or its will to run (3 s). Battery empty ≠ dead.</li>
    </ul>
    <div class="row"><button class="btn-primary" id="modal-close">UNDERSTOOD</button></div>
  `);
  $("modal-close").onclick = closeModal;
}

function promptJoin() {
  openModal(`
    <h3>JOIN MATCH</h3>
    <p>Enter the 5-letter match code:</p>
    <p><input id="join-code" maxlength="5" style="width:140px;letter-spacing:0.2em;text-transform:uppercase" placeholder="ABCDE"></p>
    <div class="row"><button class="btn-primary" id="do-join">JOIN</button><button class="btn-tertiary" id="join-cancel">CANCEL</button></div>
  `);
  $("do-join").onclick = () => {
    const c = ($("join-code") as HTMLInputElement).value.trim().toUpperCase();
    if (c.length >= 4) { closeModal(); connectOnline(`code=${c}`); }
  };
  $("join-cancel").onclick = closeModal;
}

function openModal(html: string) {
  $("modal-content").innerHTML = html;
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }

// =========================================================================
// workshop

function enterWorkshop() {
  battleKind = null;
  botSpec = null;
  botDriver = null;
  showScreen("game");
  setMode("build");
  $("btn-lock").classList.add("hidden");
  $("lobby-bar").classList.add("hidden");
  refreshPanels();
}

function setMode(m: Mode) {
  if (m === mode) return;
  if (m === "test") {
    // immutable snapshot
    testSnapshot = JSON.stringify(bp);
    const valid = preflight(bp, lobbySettings.budgetSp);
    const blockers = valid.filter((v) => !v.ok && !v.warn);
    if (blockers.length) {
      toast("BLOCKED: " + blockers[0]!.text);
      sfx.uiClick();
      return;
    }
    startTestSim();
  } else {
    // restore exact pre-test state
    if (testSnapshot) {
      const restored = migrateBlueprint(JSON.parse(testSnapshot));
      if (restored) { bp = restored; rebuildBuilder(); }
    }
    testSnapshot = null;
    sim = null;
    renderer.particles.length = 0;
  }
  mode = m;
  $("btn-test").textContent = m === "build" ? "▶ TEST" : "■ BUILD";
  $("btn-test").classList.toggle("active", m === "test");
  $("test-banner").classList.toggle("hidden", m !== "test");
  $("test-sub").textContent = battleKind === "online" ? "— the build clock is running" : battleKind === "bot" ? "— live fire" : "— physics sandbox · build clock paused";
  refreshPanels();
}

function startTestSim() {
  sim = new Simulation({
    bpA: bp,
    bpB: battleKind === "bot" && botSpec ? botSpec.build() : null,
    arena: battleKind === "bot" ? ARENAS[lobbySettings.arena] ?? ARENAS.range! : ARENAS.range!,
    seed: (Date.now() ^ 0x9e37) >>> 0,
    bots: battleKind === "bot" ? { b: botDriver ?? new DriverBot(botSpec?.difficulty ?? 0.4) } : undefined,
  });
  renderer.camX = sim.arena.width / 2;
  renderer.camY = 1.5;
  cameraFollow = true;
}

function rebuildBuilder() {
  builder = new Builder(bp, {
    onChange: () => refreshPanels(),
    onMessage: toast,
    onAction: (a) => {
      if (a === "place") sfx.place();
      else if (a === "delete") sfx.delete();
      else if (a === "wire") sfx.wire();
      else sfx.uiClick();
    },
    onSelectPart: (id) => { selectedPartId = id; refreshSelectedPanel(); },
  });
}

function startBotBattle() {
  battleKind = "bot";
  botSpec = BOT_SPECS[Math.floor(Math.random() * BOT_SPECS.length)]!;
  botDriver = new DriverBot(botSpec.difficulty);
  showScreen("game");
  mode = "build";
  $("btn-lock").classList.remove("hidden");
  $("btn-lock").textContent = "FIGHT ▸";
  $("lobby-bar").classList.remove("hidden");
  $("lobby-info").innerHTML = `SCRAMBLE vs <b>${botSpec.name}</b> — ${botSpec.desc} Build your machine, then FIGHT.`;
  setModeBuild();
  toast(`Opponent: ${botSpec.name}`);
}

function setModeBuild() {
  mode = "build";
  $("btn-test").textContent = "▶ TEST";
  $("btn-test").classList.remove("active");
  $("test-banner").classList.add("hidden");
  sim = null;
  refreshPanels();
}

function bindGameUi() {
  rebuildBuilder();
  logicEditor = new LogicEditor(bp, () => refreshPanels(), (nodeId) => renderLogicProps(nodeId));
  logicEditor.mount($("logic-canvas-host"));
  logicEditor.visible = true;

  // tool strip
  for (const btn of document.querySelectorAll("#toolstrip .tool[data-tool]")) {
    (btn as HTMLElement).onclick = () => {
      builder.tool = (btn as HTMLElement).dataset.tool as Builder["tool"];
      for (const b of document.querySelectorAll("#toolstrip .tool")) b.classList.toggle("active", b === btn);
    };
  }
  $("btn-undo").onclick = () => builder.undo();
  $("btn-redo").onclick = () => builder.redo();
  $("btn-test").onclick = () => {
    sfx.uiClick();
    if (battleKind === "online") { toast("Use READY — the match clock is server-side"); return; }
    if (mode === "build") {
      if (battleKind === "bot") { startMatchVsBot(); return; }
      setMode("test");
    } else setMode("build");
  };
  $("btn-diag").onclick = () => {
    diagMode = !diagMode;
    renderer.showPowerFlow = diagMode;
    $("btn-diag").classList.toggle("active", diagMode);
  };
  $("btn-save").onclick = () => doSave();
  $("btn-load").onclick = () => doLoad();
  $("btn-export").onclick = () => doExport();
  $("btn-import").onclick = () => doImport();
  $("btn-menu").onclick = () => { relay?.close(); relay = null; showScreen("menu"); checkRelay(); };
  $("btn-lock").onclick = () => { if (battleKind === "bot") startMatchVsBot(); };
  $("btn-lobby-ready").onclick = () => { relay?.send("set_ready", { ready: true }); sfx.uiClick(); };
  $("btn-lobby-leave").onclick = () => { relay?.close(); relay = null; battleKind = null; $("lobby-bar").classList.add("hidden"); $("btn-lock").classList.add("hidden"); };
  $("btn-rematch").onclick = () => {
    if (battleKind === "online") relay?.send("rematch", {});
    else if (battleKind === "bot") startMatchVsBot();
    $("result-overlay").classList.add("hidden");
  };
  $("btn-result-menu").onclick = () => {
    $("result-overlay").classList.add("hidden");
    enterWorkshop();
  };

  // logic categories
  const cats = $("logic-cats");
  const catDefs: [string, string[]][] = [
    ["IN", ["key_forward", "key_back", "key_fire", "key_aux", "key_turret", "sensor_value", "constant"]],
    ["MATH", ["add", "sub", "mul", "div", "abs", "clamp", "gt", "lt", "eq"]],
    ["LOGIC", ["and", "or", "not", "xor"]],
    ["FLOW", ["select", "toggle", "latch", "timer", "delay", "counter", "pid"]],
    ["OUT", ["motor_power", "servo_target", "weapon_fire", "brake"]],
  ];
  for (const [label, types] of catDefs) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = types.map((t) => NODE_DEFS[t]?.name ?? t).join(", ");
    b.onclick = () => {
      logicEditor?.addNode(types[0]!);
      // cycling through the category on repeated clicks
      const cur = types.indexOf(logicEditor ? lastAddedType : "");
      void cur;
    };
    let idx = 0;
    const orig = b.onclick;
    b.onclick = () => {
      const t = types[idx % types.length]!;
      idx++;
      logicEditor?.addNode(t);
      lastAddedType = t;
      orig;
    };
    cats.appendChild(b);
  }
  $("logic-del").onclick = () => logicEditor?.deleteSelected();

  // keyboard
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    keys.add(e.code);
    if (screen !== "game") return;
    if (e.code === "KeyT" && battleKind === null) setMode(mode === "build" ? "test" : "build");
    if (e.code === "KeyD") { diagMode = !diagMode; renderer.showPowerFlow = diagMode; $("btn-diag").classList.toggle("active", diagMode); }
    if (mode === "build") {
      if (e.code === "KeyR") builder.rotateSelected();
      if (e.code === "Delete" || e.code === "KeyX") builder.deleteSelected();
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); builder.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") { e.preventDefault(); builder.redo(); }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") builder.copySelection();
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") builder.pasteAt(buildMouseCell.x, buildMouseCell.y);
      if (e.code === "Digit1") setTool("place");
      if (e.code === "Digit2") setTool("select");
      if (e.code === "Digit3") setTool("wire");
      if (e.code === "Digit4") setTool("delete");
      if (e.code === "Escape") { builder.wireFrom = null; builder.multiSelection.clear(); }
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());

  // canvas pointer
  canvas.addEventListener("pointerdown", onCanvasDown);
  canvas.addEventListener("pointermove", onCanvasMove);
  canvas.addEventListener("pointerup", () => { dragging = null; });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    renderer.zoom = Math.max(14, Math.min(90, renderer.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

let lastAddedType = "";
let dragging: { kind: "pan" | "part"; id?: string; startX: number; startY: number; origX?: number; origY?: number; multi?: boolean } | null = null;
const buildMouseCell = { x: 0, y: 0 };

function setTool(t: Builder["tool"]) {
  builder.tool = t;
  for (const b of document.querySelectorAll("#toolstrip .tool")) {
    b.classList.toggle("active", (b as HTMLElement).dataset?.tool === t);
  }
}

function screenToCell(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const mx = renderer.camX + (sx - canvas.width / 2) / renderer.zoom;
  const my = renderer.camY + (canvas.height * 0.62 - sy) / renderer.zoom;
  return { x: Math.floor(mx / CELL), y: Math.floor(-my / CELL) };
}

function partAtCell(x: number, y: number): PlacedPart | null {
  for (const p of bp.parts) {
    const r = (() => {
      const d = part(p.def);
      return p.rot === 1 || p.rot === 3 ? { x: p.x, y: p.y, w: d.h, h: d.w } : { x: p.x, y: p.y, w: d.w, h: d.h };
    })();
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return p;
  }
  return null;
}

function onCanvasDown(e: PointerEvent) {
  canvas.setPointerCapture(e.pointerId);
  if (mode === "test") {
    // click part for diagnostics
    const c = screenToCell(e);
    const world = { x: (c.x + 0.5) * CELL, y: -(c.y + 0.5) * CELL };
    let found: string | null = null;
    for (const side of sim?.robots ?? []) {
      if (!side) continue;
      for (const p of side.bp.parts) {
        const pb = side.phys.bodies.get(p.id);
        if (!pb || pb.destroyed) continue;
        const pos = pb.body.getPosition();
        const d = part(p.def);
        if (Math.abs(pos.x - world.x) < (d.w * CELL) / 2 + 0.2 && Math.abs(pos.y - world.y) < (d.h * CELL) / 2 + 0.2) found = p.id;
      }
    }
    selectedPartId = found;
    refreshDiagPanel();
    return;
  }
  const c = screenToCell(e);
  if (e.button === 2) {
    // right click: remove
    const p = partAtCell(c.x, c.y);
    if (p) { selectedPartId = p.id; builder.deleteSelected(); }
    return;
  }
  if (builder.tool === "place" && builder.placeDefId) {
    builder.place(builder.placeDefId, c.x, c.y, builder.rot);
  } else if (builder.tool === "wire") {
    const port = builder.findPort(c.x + 0.5, c.y + 0.5, 0.8);
    if (port) {
      if (!builder.wireFrom) builder.wireStart(port.part, port.port);
      else builder.wireComplete(port.part, port.port);
    }
  } else if (builder.tool === "delete") {
    const p = partAtCell(c.x, c.y);
    if (p) { selectedPartId = p.id; builder.deleteSelected(); }
  } else {
    // select / drag
    const p = partAtCell(c.x, c.y);
    if (p) {
      selectedPartId = p.id;
      builder.multiSelection = new Set([p.id]);
      dragging = { kind: "part", id: p.id, startX: c.x, startY: c.y, origX: p.x, origY: p.y, multi: e.shiftKey };
      refreshSelectedPanel();
    } else {
      selectedPartId = null;
      dragging = { kind: "pan", startX: e.clientX, startY: e.clientY };
      refreshSelectedPanel();
    }
  }
}

function onCanvasMove(e: PointerEvent) {
  const c = screenToCell(e);
  buildMouseCell.x = c.x;
  buildMouseCell.y = c.y;
  if (mode !== "build") {
    // camera pan in test mode with drag
    if (dragging?.kind === "pan") {
      renderer.camX -= (e.clientX - dragging.startX) / renderer.zoom;
      renderer.camY += (e.clientY - dragging.startY) / renderer.zoom;
      dragging.startX = e.clientX;
      dragging.startY = e.clientY;
      cameraFollow = false;
    }
    return;
  }
  if (dragging?.kind === "pan") {
    renderer.camX -= (e.clientX - dragging.startX) / renderer.zoom;
    renderer.camY += (e.clientY - dragging.startY) / renderer.zoom;
    dragging.startX = e.clientX;
    dragging.startY = e.clientY;
    return;
  }
  if (dragging?.kind === "part" && dragging.id) {
    const p = bp.parts.find((q) => q.id === dragging!.id);
    if (p) {
      const nx = p.x + (c.x - (dragging.startX ?? 0));
      const ny = p.y + (c.y - (dragging.startY ?? 0));
      const d = part(p.def);
      const r = p.rot === 1 || p.rot === 3 ? { x: nx, y: ny, w: d.h, h: d.w } : { x: nx, y: ny, w: d.w, h: d.h };
      let free = true;
      for (const q of bp.parts) {
        if (q.id === p.id) continue;
        const qr = { x: q.x, y: q.y, w: part(q.def).w, h: part(q.def).h };
        if (r.x < qr.x + qr.w && r.x + r.w > qr.x && r.y < qr.y + qr.h && r.y + r.h > qr.y) { free = false; break; }
      }
      if (free) { p.x = nx; p.y = ny; dragging.startX = c.x; dragging.startY = c.y; refreshPanels(); }
    }
    return;
  }
  // ghost + hover
  if (builder.tool === "place" && builder.placeDefId) {
    const valid = builder.canPlaceAt(builder.placeDefId, c.x, c.y, builder.rot);
    builder.ghost = { x: c.x, y: c.y, valid };
  } else builder.ghost = null;
  const hp = partAtCell(c.x, c.y);
  hoverPartId = hp?.id ?? null;
  if (builder.tool === "wire") {
    builder.wireHover = builder.findPort(c.x + 0.5, c.y + 0.5, 0.8);
  }
}

// =========================================================================
// battles

function startMatchVsBot() {
  const valid = preflight(bp, lobbySettings.budgetSp);
  const blockers = valid.filter((v) => !v.ok && !v.warn);
  if (blockers.length) { toast("BLOCKED: " + blockers[0]!.text); return; }
  battleKind = "bot";
  if (!botSpec) botSpec = BOT_SPECS[0]!;
  if (!botDriver) botDriver = new DriverBot(botSpec.difficulty);
  resultShown = false;
  $("result-overlay").classList.add("hidden");
  sim = new Simulation({
    bpA: bp,
    bpB: botSpec.build(),
    arena: ARENAS[lobbySettings.arena] ?? ARENAS.range!,
    seed: (Date.now() ^ 0x9e37) >>> 0,
    bots: { b: botDriver },
  });
  mode = "test";
  $("btn-test").textContent = "■ BUILD";
  $("btn-test").classList.add("active");
  $("test-banner").classList.remove("hidden");
  $("test-sub").textContent = "— live fire";
  renderer.camX = sim.arena.width / 2;
  cameraFollow = true;
  combatDeadline = Date.now() + lobbySettings.combatLimitSec * 1000;
  bindSimEvents();
  countdown(sim.arena, () => {});
}

function bindSimEvents() {
  if (!sim) return;
  sim.events.onHit = (robot, _partId, force) => {
    sfx.hit(Math.min(1, force / 120));
    const side = sim!.robots[robot];
    if (side) {
      const pb = [...side.phys.bodies.values()].find((b) => !b.destroyed);
      if (pb) renderer.sparks(pb.body.getPosition().x, pb.body.getPosition().y, force);
    }
  };
  sim.events.onPartDestroyed = (robot, partId) => {
    sfx.explode();
    const side = sim!.robots[robot];
    const pb = side?.phys.bodies.get(partId);
    if (pb) {
      const p = pb.body.getPosition();
      renderer.explosion(p.x, p.y, false);
    }
  };
  sim.events.onExplosion = (x, y, big) => renderer.explosion(x, y, big);
  sim.events.onShot = (robot, x, y) => {
    sfx.shot();
    renderer.addParticle("flash", x, y, { life: 0.08, size: 22, color: "#fff8d0" });
    void robot;
  };
}

// =========================================================================
// online

function connectOnline(query: string) {
  relay = new RelayClient();
  relay.on((e) => {
    if (e.kind === "message") handleRelay(e.t, e.payload);
    else if (e.kind === "error") toast("Relay error");
    else if (e.kind === "close") toast("Relay disconnected");
  });
  relay.connect(query);
  toast("Connecting to relay…");
}

function handleRelay(t: string, payload: unknown) {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (t) {
    case "welcome": {
      mySlot = p.slot as number;
      isAuthority = mySlot === 0;
      const st = p.state as { code?: string; settings?: typeof lobbySettings };
      roomCode = st?.code ?? null;
      if (st?.settings) lobbySettings = { ...lobbySettings, ...st.settings };
      battleKind = "online";
      showScreen("game");
      setModeBuild();
      $("lobby-bar").classList.remove("hidden");
      $("btn-lock").classList.add("hidden");
      $("lobby-info").innerHTML = `ROOM <b>${roomCode}</b> — share the code · build, then READY`;
      refreshPanels();
      toast(`Connected as player ${mySlot + 1}`);
      break;
    }
    case "lobby_state": {
      const st = p as { players?: ({ ready: boolean } | null)[]; settings?: typeof lobbySettings };
      if (st.settings) lobbySettings = { ...lobbySettings, ...st.settings };
      const players = st.players ?? [];
      const both = players.length === 2 && players[0] && players[1];
      ($("btn-lobby-ready") as HTMLButtonElement).disabled = !both;
      $("lobby-info").innerHTML = `ROOM <b>${roomCode}</b> — ${both ? (players[mySlot]?.ready ? "waiting for opponent…" : "ready — waiting for opponent…") : "waiting for an opponent…"}`;
      break;
    }
    case "build_start": {
      lobbySettings = { ...lobbySettings, ...(p.settings as typeof lobbySettings) };
      $("lobby-bar").classList.add("hidden");
      $("btn-lock").classList.remove("hidden");
      $("btn-lock").textContent = "LOCK IN ▸";
      toast("BUILD PHASE — lock in when ready");
      refreshPanels();
      break;
    }
    case "match_countdown": {
      const bps = p.blueprints as (Blueprint | null)[];
      opponentBp = bps[1 - mySlot] ? migrateBlueprint(bps[1 - mySlot]) : null;
      const mine = bps[mySlot] ? migrateBlueprint(bps[mySlot]) : null;
      if (!opponentBp || !mine) { toast("Opponent blueprint invalid"); break; }
      bp = mine;
      rebuildBuilder();
      isAuthority = p.authority === mySlot;
      startOnlineMatch((p.seed as number) >>> 0, p.startAt as number);
      break;
    }
    case "input_frame": {
      const slot = p.slot as number;
      remoteInputs[slot] = unpackInputs(p);
      break;
    }
    case "snapshot": {
      if (sim && !isAuthority) sim.applySnapshotNet?.(p.data as number[], 0.3);
      break;
    }
    case "checksum": break;
    case "pong": break;
    case "peer_disconnected": toast(`Opponent disconnected — ${p.graceSec}s to reconnect`); break;
    case "peer_reconnected": toast("Opponent reconnected"); break;
    case "result": {
      const winner = p.winner as number | null;
      if (!resultShown) showResult(winner === null ? null : winner === mySlot ? 0 : 1, p.reason as string);
      break;
    }
    case "error": toast(`Relay: ${p.message ?? p.code}`); break;
    default: break;
  }
}

function startOnlineMatch(seed: number, startAt: number) {
  resultShown = false;
  $("result-overlay").classList.add("hidden");
  sim = new Simulation({
    bpA: bp,
    bpB: opponentBp,
    arena: ARENAS[lobbySettings.arena] ?? ARENAS.range!,
    seed,
  });
  mode = "test";
  $("btn-test").textContent = "■ BUILD";
  renderer.camX = sim.arena.width / 2;
  cameraFollow = true;
  combatDeadline = startAt + lobbySettings.combatLimitSec * 1000;
  bindSimEvents();
  countdown(sim.arena, () => {});
}

function showResult(playerIdx: number | null, reason: string) {
  resultShown = true;
  stopLoops();
  const banner = $("result-banner");
  banner.classList.remove("win", "lose", "draw");
  if (playerIdx === null) banner.classList.add("draw");
  else banner.classList.add(playerIdx === 0 ? "win" : "lose");
  banner.textContent = playerIdx === null ? "DRAW" : playerIdx === 0 ? "VICTORY" : "DEFEAT";
  $("result-reason").textContent = reason;
  const dur = sim ? Math.round(sim.tick / 60) : 0;
  const lost = sim ? [sim.robots[0]?.partsLost ?? 0, sim.robots[1]?.partsLost ?? 0] : [0, 0];
  $("result-stats").innerHTML = `
    <span><b>${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}</b>TIME</span>
    <span><b>${lost[0]}</b>YOUR PARTS LOST</span>
    <span><b>${lost[1]}</b>ENEMY PARTS LOST</span>`;
  $("result-overlay").classList.remove("hidden");
  if (playerIdx === null) sfx.draw();
  else if (playerIdx === 0) sfx.victory();
  else sfx.defeat();
}

// =========================================================================
// persistence actions

function doSave() {
  saveBlueprint(bp);
  toast(`Saved "${bp.name}"`);
}
function doLoad() {
  const list: SavedBlueprint[] = listSaved();
  if (!list.length) { toast("No saved blueprints"); return; }
  openModal(`
    <h3>LOAD BLUEPRINT</h3>
    <div id="bp-list">${list.map((s) => `
      <div class="kv" style="padding:6px 0;border-bottom:1px solid var(--edge)">
        <span>${s.name} <span style="color:var(--dim)">· ${Math.round(robotStats(s.bp).mass)} kg · ${s.bp.parts.length} parts</span></span>
        <span><button class="tbtn" data-load="${s.id}">LOAD</button> <button class="tbtn" data-del="${s.id}">✕</button></span>
      </div>`).join("")}</div>
    <div class="row"><button class="btn-tertiary" id="bp-close">CLOSE</button></div>
  `);
  for (const b of document.querySelectorAll("[data-load]")) {
    (b as HTMLElement).onclick = () => {
      const s = list.find((q) => q.id === (b as HTMLElement).dataset.load);
      if (s) { bp = cloneBlueprint(s.bp); rebuildBuilder(); logicEditorRebind(); refreshPanels(); toast(`Loaded ${s.name}`); }
      closeModal();
    };
  }
  for (const b of document.querySelectorAll("[data-del]")) {
    (b as HTMLElement).onclick = () => {
      deleteBlueprint((b as HTMLElement).dataset.del!);
      closeModal();
      doLoad();
    };
  }
  $("bp-close").onclick = closeModal;
}
function doExport() {
  openModal(`
    <h3>EXPORT BLUEPRINT</h3>
    <p>Copy this string to share your machine:</p>
    <textarea class="bp-textarea" readonly>${btoa(unescape(encodeURIComponent(JSON.stringify(bp))))}</textarea>
    <div class="row"><button class="btn-primary" id="bp-close">CLOSE</button></div>
  `);
  $("bp-close").onclick = closeModal;
}
function doImport() {
  openModal(`
    <h3>IMPORT BLUEPRINT</h3>
    <p>Paste a blueprint string:</p>
    <textarea class="bp-textarea" id="import-area"></textarea>
    <div class="row"><button class="btn-primary" id="do-import">IMPORT</button><button class="btn-tertiary" id="bp-close">CANCEL</button></div>
  `);
  $("do-import").onclick = () => {
    try {
      const json = decodeURIComponent(escape(atob(($("import-area") as HTMLTextAreaElement).value.trim())));
      const parsed = migrateBlueprint(JSON.parse(json));
      if (parsed) { bp = parsed; rebuildBuilder(); logicEditorRebind(); refreshPanels(); toast("Blueprint imported"); }
      else toast("Invalid blueprint");
    } catch { toast("Invalid blueprint string"); }
    closeModal();
  };
  $("bp-close").onclick = closeModal;
}

function logicEditorRebind() {
  logicEditor = new LogicEditor(bp, () => refreshPanels(), (nodeId) => renderLogicProps(nodeId));
  const host = $("logic-canvas-host");
  host.innerHTML = "";
  logicEditor.mount(host);
  logicEditor.visible = true;
}

// =========================================================================
// panels

function refreshPanels() {
  if (screen !== "game") return;
  const st = robotStats(bp);
  const maxMass = lobbySettings.budgetSp;
  $("mass-num").textContent = `${Math.round(st.mass)}/${maxMass}`;
  const fill = $("mass-fill");
  const frac = Math.min(1.2, st.mass / maxMass);
  fill.style.width = `${Math.min(100, frac * 100)}%`;
  fill.className = frac > 1 ? "over" : frac > 0.85 ? "warn" : "";

  const hasCpu = st.cpuProvided >= st.cpuUsed;
  $("robot-info").innerHTML = `
    <div class="kv"><span class="k">WEIGHT</span><span class="v">${Math.round(st.mass)} / ${maxMass} kg</span></div>
    <div class="kv"><span class="k">POWER</span><span class="v">${st.genWatts} / ${st.genWatts + 2000} W</span></div>
    <div class="kv"><span class="k">ENERGY CAP.</span><span class="v">${(st.energyKJ / 1000).toFixed(1)} MJ</span></div>
    <div class="kv"><span class="k">PARTS</span><span class="v">${st.parts}</span></div>
    <div class="kv"><span class="k">CPU USAGE</span><span class="v ${hasCpu ? "good" : "bad"}">${st.cpuProvided ? Math.round((st.cpuUsed / st.cpuProvided) * 100) : "—"}%</span></div>
    <div class="kv"><span class="k">WHEELS / MOTORS</span><span class="v">${st.wheels} / ${st.motors}</span></div>
    <div class="kv"><span class="k">SENSORS</span><span class="v">${st.sensors}</span></div>`;

  if (mode === "test" && sim) {
    const side = sim.robots[0]!;
    $("power-grid").innerHTML = `
      <div class="kv"><span class="k">GENERATION</span><span class="v">${Math.round(side.net.generation)} W</span></div>
      <div class="kv"><span class="k">CONSUMPTION</span><span class="v">${Math.round(side.net.consumption)} W</span></div>
      <div class="kv"><span class="k">BATTERY</span><span class="v ${side.net.storedKJ <= 0 ? "bad" : ""}">${(side.net.storedKJ / 1000).toFixed(1)} / ${(side.net.capacityKJ / 1000).toFixed(1)} MJ</span></div>
      <div class="kv"><span class="k">VOLTAGE</span><span class="v">${side.net.busVoltage.toFixed(1)} V</span></div>
      <div class="kv"><span class="k">CURRENT</span><span class="v">${side.net.busCurrent.toFixed(1)} A</span></div>
      <div class="kv"><span class="k">EFFICIENCY</span><span class="v ${side.net.efficiency < 75 ? "warn" : "good"}">${side.net.efficiency}%</span></div>`;
    powerHistory.push(side.net.consumption);
    if (powerHistory.length > 80) powerHistory.shift();
    drawPowerGraph();
    // condition chips
    const chips = [];
    chips.push(`<div class="kv"><span class="k">MOBILITY</span><span class="v ${side.lastResult.mobility ? "good" : "bad"}">${side.lastResult.mobility ? "OK" : "LOST"}</span></div>`);
    chips.push(`<div class="kv"><span class="k">OFFENSE</span><span class="v ${side.lastResult.offense ? "good" : "bad"}">${side.lastResult.offense ? "OK" : "LOST"}</span></div>`);
    chips.push(`<div class="kv"><span class="k">CONTROL</span><span class="v ${side.lastResult.control ? "good" : "bad"}">${side.lastResult.control ? "OK" : "LOST"}</span></div>`);
    if (side.destroyedTimer > 0) chips.push(`<div class="kv"><span class="k">KO TIMER</span><span class="v bad">${side.destroyedTimer.toFixed(1)}s</span></div>`);
    $("logic-summary").innerHTML = chips.join("");
  } else {
    $("power-grid").innerHTML = `
      <div class="kv"><span class="k">GENERATION</span><span class="v">${st.genWatts} W</span></div>
      <div class="kv"><span class="k">BATTERY</span><span class="v">${(st.energyKJ / 1000).toFixed(1)} MJ</span></div>
      <div class="kv"><span class="k">IDLE DRAW</span><span class="v">${st.idleWatts} W</span></div>
      <div class="kv"><span class="k">CPU SLOTS</span><span class="v ${hasCpu ? "good" : "bad"}">${st.cpuUsed} / ${st.cpuProvided}</span></div>`;
    $("logic-summary").innerHTML = bp.logic.slice(0, 6).map((n) => {
      const d = NODE_DEFS[n.type];
      const target = n.params.part ? ` [${partLabel(n.params.part as string)}]` : "";
      return `· ${d?.name ?? n.type}${target}`;
    }).join("<br>") || '<span style="color:var(--dim)">No logic yet — add nodes below.</span>';
  }

  // preflight checklist in build mode
  if (mode === "build") {
    const checks = preflight(bp, maxMass);
    $("diag-body").innerHTML = checks.map((c) => `<div style="color:${c.ok ? "var(--good)" : c.warn ? "var(--warn)" : "var(--bad)"}">${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.text}</div>`).join("");
  }

  renderBinTabs();
  logicEditor?.render();
}

function partLabel(partId: string): string {
  const p = bp.parts.find((q) => q.id === partId);
  return p ? part(p.def).name : "?";
}

let binCat: Category = "structure";
function renderBinTabs() {
  const tabs = $("bin-tabs");
  if (!tabs.childElementCount) {
    for (const c of CATEGORY_LIST) {
      const b = document.createElement("button");
      b.textContent = c.name;
      b.onclick = () => { binCat = c.id; renderBin(); };
      b.dataset.cat = c.id;
      tabs.appendChild(b);
    }
  }
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("active", (b as HTMLElement).dataset.cat === binCat);
  const items = $("bin-items");
  if (!items.childElementCount || items.dataset.cat !== binCat) renderBin();
}

function renderBin() {
  const items = $("bin-items");
  items.dataset.cat = binCat;
  items.innerHTML = "";
  import("./game/parts").then(({ PARTS }) => {
    for (const d of PARTS) {
      if (d.cat !== binCat) continue;
      const div = document.createElement("div");
      div.className = "bin-item" + (builder.placeDefId === d.id ? " active" : "");
      div.innerHTML = `<div class="bin-name">${d.name}</div>
        <div class="bin-meta">$${d.cost} · ${d.mass} kg · ${d.hp} hp</div>
        <div class="bin-desc">${d.desc}</div>`;
      div.onclick = () => {
        builder.placeDefId = d.id;
        builder.tool = "place";
        setTool("place");
        renderBin();
        $("sel-title").textContent = d.name.toUpperCase();
        $("sel-body").innerHTML = selectedPartSpec(d.id);
      };
      items.appendChild(div);
    }
  });
}

function selectedPartSpec(defId: string): string {
  const d = part(defId);
  const rows: [string, string][] = [["Weight", `${d.mass} kg`], ["Cost", `$${d.cost}`], ["Health", `${d.hp}`], ["Armor", d.armor ? `${Math.round((1 / d.armor) * 100)}%` : "—"]];
  if (d.motor) rows.push(["Torque", `${d.motor.torque} Nm`], ["Max RPM", `${d.motor.rpm}`], ["Power", `${d.motor.watts} W`]);
  if (d.source?.watts) rows.push(["Output", `${d.source.watts} W`]);
  if (d.source?.energyKJ) rows.push(["Capacity", `${(d.source.energyKJ / 1000).toFixed(1)} MJ`]);
  if (d.capacitor) rows.push(["Buffer", `${d.capacitor.kJ} kJ`]);
  if (d.fuse) rows.push(["Rating", `${d.fuse.amps} A`]);
  if (d.cpu) rows.push(["CPU slots", `${d.cpu}`]);
  if (d.sensor) rows.push(["Reads", d.sensor.kind], ["Range", `${d.sensor.range ?? "—"} m`]);
  if (d.weapon && !d.barrel) rows.push(["Damage", `${d.weapon.dmg}`], ["Draw", `${d.weapon.watts} W`], ["Ammo", d.weapon.ammoCap ? `${d.weapon.ammoCap}` : d.weapon.kind === "rail" ? "capacitor" : "—"]);
  if (d.piston) rows.push(["Force", `${d.piston.force} N`], ["Stroke", `${d.piston.range} m`]);
  if (d.wheel) rows.push(["Diameter", `${d.wheel.radius * 2} m`], ["Grip", `${d.wheel.grip}`]);
  if (d.cooling) rows.push(["Cooling", `${d.cooling.rate}x`]);
  const ports = d.ports.map((p) => `${["LEFT", "TOP", "RIGHT", "BOTTOM"][p.side]} ${p.kind.toUpperCase()}`).join(", ");
  if (ports) rows.push(["Ports", ports]);
  return `<div style="color:var(--dim);margin-bottom:6px">${d.desc}</div>` + rows.map(([k, v]) => `<div><span class="spec-k">${k}:</span> ${v}</div>`).join("");
}

function refreshSelectedPanel() {
  const p = bp.parts.find((q) => q.id === selectedPartId);
  if (!p) { $("sel-title").textContent = "COMPONENT"; $("sel-body").innerHTML = "Click a part to inspect it."; return; }
  const d = part(p.def);
  $("sel-title").textContent = d.name.toUpperCase();
  $("sel-body").innerHTML = selectedPartSpec(p.def) + `<div style="margin-top:6px;color:var(--dim)">ID ${p.id.slice(-4)} · grid (${p.x},${p.y})</div>`;
}

function refreshDiagPanel() {
  if (!selectedPartId || !sim) { $("diag-body").innerHTML = "Select a component in TEST mode…"; return; }
  const side = sim.sideOfPart(selectedPartId);
  if (!side) { $("diag-body").innerHTML = "Part not in simulation."; return; }
  const pb = side.phys.bodies.get(selectedPartId);
  if (!pb) { $("diag-body").innerHTML = "DESTROYED"; return; }
  const d = pb.def;
  const load = side.net.loads.get(selectedPartId);
  const temp = side.heat.get(selectedPartId) ?? 20;
  const wheel = side.phys.wheels.find((w) => w.partId === selectedPartId);
  const rpm = wheel ? Math.abs(wheel.joint.getJointSpeed()) * 60 / (2 * Math.PI) : pb.spinRate ? Math.abs(pb.spinRate) * 60 / (2 * Math.PI) : 0;
  const trace = powerTrace(side, selectedPartId);
  $("diag-body").innerHTML = `
    <div class="kv"><span class="k">COMPONENT</span><span class="v">${d.name}</span></div>
    <div class="kv"><span class="k">RPM</span><span class="v">${Math.round(rpm)}</span></div>
    <div class="kv"><span class="k">HEALTH</span><span class="v ${pb.hp / pb.maxHp < 0.4 ? "bad" : pb.hp / pb.maxHp < 0.75 ? "warn" : "good"}">${Math.max(0, Math.round((pb.hp / pb.maxHp) * 100))}%</span></div>
    <div class="kv"><span class="k">TEMPERATURE</span><span class="v ${temp > 100 ? "bad" : temp > 70 ? "warn" : "good"}">${Math.round(temp)}°C</span></div>
    <div class="kv"><span class="k">POWER</span><span class="v ${load?.powered ? "good" : "bad"}">${load?.powered ? `${Math.round(load.deliveredWatts)} W @ ${load.voltage.toFixed(0)} V` : "OFFLINE"}</span></div>
    <div class="kv"><span class="k">CURRENT</span><span class="v">${(load?.amps ?? 0).toFixed(1)} A</span></div>
    ${trace ? `<div style="margin-top:6px;color:var(--dim)">TRACE:</div><div style="color:var(--dim)">${trace}</div>` : ""}`;
}

function powerTrace(side: { bp: Blueprint; net: PowerNetLocal }, partId: string): string {
  // walk wires back toward a source
  const wireAdj = new Map<string, string[]>();
  for (const w of side.bp.wires) {
    if (!wireAdj.has(w.a.part)) wireAdj.set(w.a.part, []);
    if (!wireAdj.has(w.b.part)) wireAdj.set(w.b.part, []);
    wireAdj.get(w.a.part)!.push(w.b.part);
    wireAdj.get(w.b.part)!.push(w.a.part);
  }
  const seen = new Set<string>([partId]);
  const q: string[] = [partId];
  let source: string | null = null;
  const path: string[] = [partId];
  while (q.length) {
    const cur = q.shift()!;
    const d = part(side.bp.parts.find((p) => p.id === cur)?.def ?? "");
    if (d.source) { source = cur; break; }
    for (const n of wireAdj.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      path.push(n);
      q.push(n);
    }
  }
  if (!source) return "NO PATH TO POWER";
  path.push(source);
  return path.map((id) => {
    const d = part(side.bp.parts.find((p) => p.id === id)?.def ?? "");
    return d.name;
  }).join(" ← ");
}
type PowerNetLocal = import("./game/electric").PowerNet;

function drawPowerGraph() {
  const cv = $("power-graph") as HTMLCanvasElement;
  cv.width = cv.clientWidth || 230;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#10151b";
  g.fillRect(0, 0, cv.width, cv.height);
  const max = Math.max(2000, ...powerHistory);
  g.strokeStyle = "#2a333e";
  for (const frac of [0.25, 0.5, 0.75]) {
    g.beginPath();
    g.moveTo(0, cv.height * frac);
    g.lineTo(cv.width, cv.height * frac);
    g.stroke();
  }
  g.strokeStyle = "#5fbf5f";
  g.beginPath();
  powerHistory.forEach((v, i) => {
    const x = (i / 79) * cv.width;
    const y = cv.height - (v / max) * (cv.height - 6) - 3;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

function renderLogicProps(nodeId: string | null) {
  const el = $("logic-props");
  if (!nodeId) { el.classList.add("hidden"); return; }
  const n = bp.logic.find((q) => q.id === nodeId);
  if (!n) { el.classList.add("hidden"); return; }
  const def = NODE_DEFS[n.type];
  let html = `<b style="color:var(--accent)">${def?.name ?? n.type}</b> — ${def?.desc ?? ""}<br>`;
  for (const p of def?.params ?? []) {
    if (p.kind === "number") {
      html += `${p.label}: <input type="number" step="0.1" value="${n.params[p.key] ?? 0}" data-node="${n.id}" data-param="${p.key}">`;
    } else if (p.kind === "target") {
      const opts = targetOptions(bp, p.options ?? []);
      html += `${p.label}: <select data-node="${n.id}" data-param="${p.key}"><option value="">—</option>${opts.map((o) => `<option value="${o.id}" ${n.params[p.key] === o.id ? "selected" : ""}>${o.label}</option>`).join("")}</select>`;
    }
  }
  el.innerHTML = html;
  el.classList.remove("hidden");
  for (const input of el.querySelectorAll("[data-node]")) {
    input.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      const nid = t.dataset.node!;
      const key = t.dataset.param!;
      const node = bp.logic.find((q) => q.id === nid);
      if (node) node.params[key] = t.type === "number" ? parseFloat(t.value) : t.value;
      refreshPanels();
    });
  }
}

// =========================================================================
// game loop

let countdownEnd = 0;

function countdown(_arena: unknown, cb: () => void) {
  const el = $("countdown");
  el.classList.remove("hidden");
  countdownEnd = Date.now() + 3000;
  let last = 4;
  const iv = setInterval(() => {
    const remain = Math.ceil((countdownEnd - Date.now()) / 1000);
    if (remain <= 0) { el.classList.add("hidden"); clearInterval(iv); cb(); return; }
    if (remain !== last) { last = remain; sfx.countdown(remain <= 1); el.textContent = String(remain); }
  }, 100);
}

function frame(now: number) {
  requestAnimationFrame(frame);
  try {
    frameBody(now);
  } catch (err) {
    (window as unknown as { __err: string }).__err = String((err as Error).stack ?? err);
    console.error(err);
  }
}

function frameBody(now: number) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $("toast").classList.add("hidden"); }
  if (screen === "menu") { drawMenuBg(); return; }

  // player inputs (test mode)
  if (mode === "test" && sim) {
    input.forward = keys.has("KeyW") || keys.has("ArrowRight") ? 1 : 0;
    input.back = keys.has("KeyS") || keys.has("ArrowLeft") ? 1 : 0;
    input.fire = keys.has("Space") ? 1 : 0;
    input.aux = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1 : 0;
    input.turret = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);

    // player inputs (bot battles + test mode): side 0 is the player
    if (mode === "test" && battleKind !== "online" && sim.robots[0] && !sim.robots[0].defeated) {
      sim.robots[0].input = { forward: input.forward, back: input.back, fire: input.fire, aux: input.aux, turret: input.turret };
    }

    // online: send inputs, apply remote
    if (battleKind === "online" && relay) {
      if (sim.tick % 2 === 0) relay.send("input_frame", { ...packInputs({ ...input }), tick: sim.tick });
      const mine = sim.robots[mySlot];
      const other = sim.robots[1 - mySlot];
      const rem = remoteInputs[1 - mySlot]!;
      if (mine && !mine.defeated) mine.input = { ...input };
      if (other && !other.defeated) other.input = { ...rem };
    }

    // step at 60 Hz fixed
    if (Date.now() >= (combatDeadline - lobbySettings.combatLimitSec * 1000) || battleKind !== "online") {
      acc += dt;
      let steps = 0;
      while (acc >= TICK && steps < 5) {
        const bots = battleKind === "bot" ? { b: botDriver ?? undefined } : undefined;
        sim.step(TICK, undefined, bots?.b);
        acc -= TICK;
        steps++;
        if (sim.outcome && !resultShown) {
          const outcome = sim.outcome;
          const winner = outcome.kind === "timeout" ? null : outcome.winner;
          const playerWon = winner === null ? null : battleKind === "online" ? (winner === mySlot ? 0 : 1) : winner === 0 ? 0 : 1;
          const reason =
            outcome.kind === "timeout"
              ? "TIME LIMIT — DRAW"
              : outcome.winner === null
                ? "MUTUAL DESTRUCTION"
                : `robot ${outcome.winner === 0 ? "1 (YOU)" : "2 (ENEMY)"} DISABLED`;
          showResult(playerWon, reason);
          if (battleKind === "online") relay?.send("checksum", { tick: sim.tick, hash: sim.checksumNet?.() ?? "0" });
          break;
        }
      }
    }

    // camera follow the action
    if (cameraFollow) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const side of sim.robots) {
        if (!side) continue;
        const pos = side.phys.rootBody?.getPosition();
        if (pos) { cx += pos.x; cy += pos.y; n++; }
      }
      if (n) {
        renderer.camX += (cx / n - renderer.camX) * Math.min(1, dt * 3);
        renderer.camY += (Math.max(1.5, cy / n) - renderer.camY) * Math.min(1, dt * 3);
      }
      // zoom out to fit both robots (px per meter)
      if (sim.robots[0] && sim.robots[1]) {
        const a = sim.robots[0]!.phys.rootBody?.getPosition();
        const b = sim.robots[1]!.phys.rootBody?.getPosition();
        if (a && b) {
          const sep = Math.hypot(a.x - b.x, a.y - b.y);
          const want = Math.max(26, Math.min(56, sep * 1.3 + 18));
          renderer.zoom += (want - renderer.zoom) * Math.min(1, dt);
        }
      }
    }

    // drive sound
    const me = sim.robots[mySlot === 0 && battleKind !== "bot" ? 0 : 0];
    if (me) {
      updateDriveSound(Math.min(1, Math.abs(me.input.forward - me.input.back)));
      let spin = 0;
      for (const p of me.bp.parts) {
        const d = part(p.def);
        if (d.weapon?.kind === "spinner") {
          const pb = me.phys.bodies.get(p.id);
          if (pb) spin = Math.max(spin, Math.min(1, pb.spinRate / 26));
        }
      }
      updateWeaponSound(spin);
    }

    // panels at ~5 Hz
    if (sim.tick % 12 === 0) {
      refreshPanels();
      if (selectedPartId) refreshDiagPanel();
    }
    // combat timeout
    if (battleKind !== null && combatDeadline > 0 && Date.now() >= combatDeadline && !resultShown && !sim.outcome) {
      showResult(null, "TIME LIMIT — DRAW");
    }
  }

  renderer.update(dt);
  renderer.render(ctx, canvas.width, canvas.height, sim, bp, mode === "build");
  if (mode === "build") renderBuildOverlays(ctx);
  logicEditor?.render();
}

// build overlays: ghost, wire preview
function renderBuildOverlays(ctx: CanvasRenderingContext2D) {
  const z = renderer.zoom;
  const tx = (mx: number) => canvas.width / 2 + (mx - renderer.camX) * z;
  const ty = (my: number) => canvas.height * 0.62 - (my - renderer.camY) * z;
  // ghost
  if (builder.ghost && builder.placeDefId) {
    const d = part(builder.placeDefId);
    const gw = (builder.rot === 1 || builder.rot === 3 ? d.h : d.w) * CELL * z;
    const gh = (builder.rot === 1 || builder.rot === 3 ? d.w : d.h) * CELL * z;
    const gx = tx(builder.ghost.x * CELL);
    const gy = ty((builder.ghost.y + (builder.rot === 1 || builder.rot === 3 ? d.w : d.h)) * CELL);
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = builder.ghost.valid ? "#5fbf5f" : "#c05038";
    ctx.fillRect(gx, gy, gw, gh);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = builder.ghost.valid ? "#8fdf8f" : "#e07050";
    ctx.strokeRect(gx, gy, gw, gh);
    ctx.globalAlpha = 1;
  }
  // wire preview
  if (builder.tool === "wire" && builder.wireFrom) {
    const a = portWorldPos(bp, builder.wireFrom.part, builder.wireFrom.port);
    if (a) {
      const ax = tx(a.x * CELL);
      const ay = ty(a.y * CELL);
      const bx = tx(buildMouseCell.x * CELL + CELL / 2);
      const by = ty(buildMouseCell.y * CELL + CELL / 2);
      ctx.strokeStyle = "#ffd866";
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // port markers in wire mode
  if (builder.tool === "wire") {
    for (const p of bp.parts) {
      const d = part(p.def);
      for (let i = 0; i < d.ports.length; i++) {
        const pos = portWorldPos(bp, p.id, i);
        if (!pos) continue;
        const isFrom = builder.wireFrom?.part === p.id && builder.wireFrom?.port === i;
        const isHover = builder.wireHover?.part === p.id && builder.wireHover?.port === i;
        ctx.fillStyle = isFrom ? "#ffd866" : isHover ? "#ffffff" : d.ports[i]!.kind === "power" ? "#d9a441" : "#3ab8b8";
        ctx.beginPath();
        ctx.arc(tx(pos.x * CELL), ty(pos.y * CELL), isHover || isFrom ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // hover outline
  if (hoverPartId && builder.tool !== "place") {
    const p = bp.parts.find((q) => q.id === hoverPartId);
    if (p) {
      const d = part(p.def);
      const r = { x: p.x, y: p.y, w: d.w, h: d.h };
      ctx.strokeStyle = "rgba(120,200,255,0.7)";
      ctx.strokeRect(tx(r.x * CELL), ty((r.y + r.h) * CELL), r.w * CELL * z, r.h * CELL * z);
    }
  }
}

// extend Simulation with net snapshot hooks (attached lazily to keep sim decoupled)
declare module "./game/sim" {
  interface Simulation {
    applySnapshotNet?(data: number[], blend: number): void;
    checksumNet?(): string;
  }
}
Object.defineProperty(Simulation.prototype, "applySnapshotNet", {
  value: function (this: Simulation, data: number[], _blend: number) {
    void data; void _blend;
    // planck bodies: apply authority positions (quantized) — implemented via sim state
    // for the prototype the non-authority client re-simulates; snapshots nudge velocities
    if (!data.length) return;
    let i = 0;
    for (const side of this.robots) {
      if (!side) continue;
      for (const [, pb] of side.phys.bodies) {
        if (pb.destroyed || i + 6 > data.length) { i += 7; continue; }
        const vx = data[i++]!;
        const vy = data[i++]!;
        const av = data[i++]!;
        void vx; void vy; void av;
        i += 4;
      }
    }
  },
});
Object.defineProperty(Simulation.prototype, "checksumNet", {
  value: function (this: Simulation): string {
    let h = 0x811c9dc5;
    const mix = (n: number) => { h = (Math.imul(h ^ (Math.round(n * 16) & 0xffff), 0x01000193)) >>> 0; };
    for (const side of this.robots) {
      if (!side) continue;
      for (const [, pb] of side.phys.bodies) {
        if (pb.destroyed) continue;
        const p = pb.body.getPosition();
        mix(p.x); mix(p.y);
      }
    }
    return h.toString(16);
  },
});

boot();

// dev/testing hooks
(window as unknown as { __dev: unknown }).__dev = {
  loadBot: (id: string) => {
    const spec = BOT_SPECS.find((b) => b.id === id);
    if (spec) {
      bp = spec.build();
      bp.name = spec.name + " (copy)";
      rebuildBuilder();
      logicEditorRebind();
      refreshPanels();
    }
  },
  loadCart: () => {
    // a complete reference cart: hull, powered wheels, battery, controller, wires, drive logic
    const b = emptyBlueprint("Reference Cart");
    const P = (def: string, x: number, y: number) => {
      const p: PlacedPart = { id: uid("p"), def, x, y, rot: 0 };
      b.parts.push(p);
      return p;
    };
    const W = (a: PlacedPart, ap: number, bq: PlacedPart, bp2: number) => b.wires.push({ id: uid("w"), a: { part: a.id, port: ap }, b: { part: bq.id, port: bp2 } });
    // chassis row y0..2 (alu frame 2x2 + blocks), battery + controller on top (y-1)
    P("alu_frame", 1, 0);
    P("steel_block", 0, 1);
    const bat = P("battery_pack", 1, -1);
    const cpu = P("micro_controller", 0, -1);
    const m1 = P("motor_small", 1, 2);
    const m2 = P("motor_small", 2, 2);
    P("wheel_medium", 1, 3);
    P("wheel_medium", 2, 3);
    W(bat, 0, cpu, 0);
    W(bat, 0, m1, 0);
    W(m1, 2, m2, 0);
    // drive logic: FORWARD - REVERSE -> both motors
    const kf = { id: uid("n"), type: "key_forward", x: 0, y: 0, params: {}, in: {} };
    const kb = { id: uid("n"), type: "key_back", x: 0, y: 2, params: {}, in: {} };
    const mix = { id: uid("n"), type: "sub", x: 2, y: 0, params: {}, in: { a: kf.id, b: kb.id } };
    const cl = { id: uid("n"), type: "clamp", x: 4, y: 0, params: { min: -1, max: 1 }, in: { a: mix.id } };
    const o1 = { id: uid("n"), type: "motor_power", x: 6, y: 0, params: { part: m1.id }, in: { val: cl.id } };
    const o2 = { id: uid("n"), type: "motor_power", x: 6, y: 2, params: { part: m2.id }, in: { val: cl.id } };
    b.logic.push(kf, kb, mix, cl, o1, o2);
    bp = b;
    rebuildBuilder();
    logicEditorRebind();
    refreshPanels();
  },
  startBotBattle: (id?: string) => {
    if (id) {
      const spec = BOT_SPECS.find((b) => b.id === id);
      if (spec) { botSpec = spec; botDriver = new DriverBot(spec.difficulty); }
    }
    startBotBattle();
    if (id && botSpec?.id === id) { /* keep */ }
    // for tests: auto-start the fight
    setTimeout(() => startMatchVsBot(), 50);
  },
  state: () => ({
    mode,
    battleKind,
    screen,
    sim: sim
      ? {
          tick: sim.tick,
          outcome: sim.outcome,
          a: {
            pos: sim.robots[0]?.phys.rootBody?.getPosition() ?? null,
            partsLost: sim.robots[0]?.partsLost,
            defeated: sim.robots[0]?.defeated,
            charge: sim.robots[0] ? Math.round((sim.robots[0].net.storedKJ / Math.max(sim.robots[0].net.capacityKJ, 1)) * 100) : 0,
            last: sim.robots[0]?.lastResult,
            inputs: sim.robots[0]?.input,
            motorPowers: [...(sim.lastMotorPowers?.entries() ?? [])].map(([k, v]) => [k.slice(-4), Math.round(v * 100) / 100]),
            trackPowered: sim.robots[0].phys.tracks.map((t) => sim!.robots[0]!.net.loads.get(t.partId)?.powered ?? null),
          },
          b: sim.robots[1]
            ? { pos: sim.robots[1].phys.rootBody?.getPosition() ?? null, partsLost: sim.robots[1].partsLost, defeated: sim.robots[1].defeated, last: sim.robots[1].lastResult, input: sim.robots[1].input }
            : null,
          projectiles: sim.projectiles.length,
        }
      : null,
  }),
  bp: () => bp,
};
