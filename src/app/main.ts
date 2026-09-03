// SCRAP AND STEEL — app/main.ts
// Boot, screen state machine, game loop, HUD. Rendering stays outside UI re-renders;
// the only state store is the DOM itself (deliberately boring).

import { initPhysics } from "../sim/adapter";
import { MatchSimulation, TICK_DT } from "../sim/simulation";
import { newRobotInput, type RobotInput } from "../sim/robot";
import { GameRenderer, OrbitCam } from "../render/scene";
import { BuildEditor } from "../editor/editor";
import { InputState } from "../control/input";
import { PART_DEFS, PART_LIST, CATEGORIES, ARENAS, BUDGET_PRESETS, type PartCategory, type ArenaDef } from "../content/parts";
import { DEFAULT_SETTINGS, type Blueprint, type BuildSettings, type InputChannel, blueprintCost } from "../blueprint/types";
import { blueprintHash } from "../blueprint/canonical";
import { RelayClient, resolveRelayUrl } from "../net/client";
import { GAME_VERSION, PROTOCOL_VERSION } from "../../shared/protocol";
import { buildAiBot, AiController } from "../combat/ai";
import { migrateBlueprint } from "../blueprint/types";

type Screen = "menu" | "lobby" | "build" | "combat";
type Mode = "solo" | "test" | "online";

const $ = (id: string) => document.getElementById(id)!;

let currentScreen: Screen = "menu";
let mode: Mode = "solo";
let sim: MatchSimulation | null = null;
let renderer: GameRenderer | null = null;
let orbit: OrbitCam | null = null;
let editor: BuildEditor | null = null;
let input = new InputState();
let relay: RelayClient | null = null;
let mySlot = 0;
let isAuthority = true;
let roomCode: string | null = null;
let settings: BuildSettings = { ...DEFAULT_SETTINGS };
let buildDeadline = 0;
let combatDeadline = 0;
let testSnapshot: string | null = null;
let testing = false;
let acc = 0;
let lastFrame = 0;
let remoteInput: [RobotInput, RobotInput] = [newRobotInput(), newRobotInput()];
let ai: AiController | null = null;
let snapshotTimer = 0;
let checksumTimer = 0;
let inputTimer = 0;
let lastChecksumPeer = "";
let desyncWarnings = 0;
let ping = 0;
let pingTimer = 0;
let debugVisible = false;

const canvas = $("gl") as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// screen helpers

function show(screen: Screen) {
  currentScreen = screen;
  for (const s of ["menu", "lobby", "build", "combat"] as Screen[]) {
    $(`screen-${s}`).classList.toggle("hidden", s !== screen);
  }
}

function message(text: string) {
  const el = $("build-msg");
  el.textContent = text;
  el.classList.remove("hidden");
  window.setTimeout(() => el.classList.add("hidden"), 2200);
}

// ---------------------------------------------------------------------------
// boot

async function boot() {
  $("ver-text").textContent = `v${GAME_VERSION} · protocol v${PROTOCOL_VERSION}`;
  renderer = new GameRenderer(canvas);
  renderer.setQuality("medium");
  orbit = new OrbitCam(renderer.camera, canvas);
  input = new InputState();
  await initPhysics();
  checkRelay();
  show("menu");
  bindMenu();
  bindBuildUi();
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);
}

function resize() {
  if (!renderer) return;
  renderer.resize(window.innerWidth, window.innerHeight);
}

async function checkRelay() {
  const el = $("relay-status");
  el.textContent = `relay: ${resolveRelayUrl()}`;
  try {
    const resp = await fetch(`${resolveRelayUrl().replace(/^ws/, "http")}/health`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      el.textContent += " · online";
      el.classList.add("ok");
    } else {
      el.textContent += " · error";
      el.classList.add("bad");
    }
  } catch {
    el.textContent += " · offline (solo play still works)";
    el.classList.add("bad");
  }
}

// ---------------------------------------------------------------------------
// menu

function arena(id: string): ArenaDef {
  return ARENAS[id] ?? ARENAS.foundry!;
}

function startSolo() {
  mode = "solo";
  settings = { ...DEFAULT_SETTINGS };
  enterBuild("solo");
}

function bindMenu() {
  $("btn-solo").onclick = () => startSolo();
  $("btn-online").onclick = () => connectOnline("create=1");
  $("btn-join").onclick = () => promptJoin();
  $("btn-help").onclick = () => showHelp();
  $("btn-leave-lobby").onclick = () => leaveOnline();
  $("btn-copy-code").onclick = () => {
    if (roomCode) navigator.clipboard?.writeText(roomCode).catch(() => {});
  };
  $("btn-ready").onclick = () => {
    relay?.send("set_ready", { ready: true });
  };
  $("btn-result-menu").onclick = () => backToMenu();
  $("btn-rematch").onclick = () => onRematch();
  $("btn-leave-build").onclick = () => onLeaveBuild();
  $("btn-lock").onclick = () => onLockIn();
  $("btn-test").onclick = () => toggleTest();
  $("btn-undo").onclick = () => editor?.undo();
  $("btn-redo").onclick = () => editor?.redo();
  window.addEventListener("keydown", (e) => {
    if (e.code === "Backquote") {
      debugVisible = !debugVisible;
      $("debug-overlay").classList.toggle("hidden", !debugVisible);
    }
  });
}

function showHelp() {
  openModal(`
    <h3>How to play</h3>
    <ul>
      <li><b>Build:</b> pick parts from the bin, click in the world to place. R rotates, X deletes, Ctrl+D duplicates. Wheels must touch a motor to be driven.</li>
      <li><b>Wire:</b> switch to the Wire tool and click battery → motor/weapon. No wire, no power.</li>
      <li><b>Controls:</b> motors are auto-bound to W/S/A/D. Weapons fire with Space.</li>
      <li><b>Test:</b> Start Test simulates your robot with real physics. End Test restores your build exactly.</li>
      <li><b>Fight:</b> a robot dies when it can no longer move <i>and</i> cannot attack — for 3 straight seconds. An empty battery is not death.</li>
    </ul>
    <div class="row"><button class="big" onclick="document.getElementById('modal').classList.add('hidden')">Got it</button></div>
  `);
}

function promptJoin() {
  openModal(`
    <h3>Join a room</h3>
    <p>Enter the 5-letter room code:</p>
    <p><input id="join-code" maxlength="5" placeholder="ABCDE" /></p>
    <div class="row">
      <button class="big" id="do-join">Join</button>
      <button class="small" onclick="document.getElementById('modal').classList.add('hidden')">Cancel</button>
    </div>
  `);
  $("do-join").onclick = () => {
    const code = ($("join-code") as HTMLInputElement).value.trim().toUpperCase();
    if (code.length >= 4) {
      $("modal").classList.add("hidden");
      connectOnline(`code=${code}`);
    }
  };
}

function openModal(html: string) {
  $("modal-content").innerHTML = html;
  $("modal").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// online

function connectOnline(query: string) {
  relay = new RelayClient();
  relay.on((e) => {
    if (e.kind === "message") handleRelayMessage(e.t, e.payload);
    else if (e.kind === "error") message("Relay error");
  });
  relay.connect(query);
  message("Connecting to relay…");
}

function handleRelayMessage(t: string, payload: unknown) {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (t) {
    case "welcome": {
      mySlot = p.slot as number;
      roomCode = (p.state as { code?: string })?.code ?? null;
      show("lobby");
      renderLobby(p.state as Record<string, unknown>);
      message(`Connected as player ${mySlot + 1}`);
      break;
    }
    case "lobby_state":
      renderLobby(p as Record<string, unknown>);
      break;
    case "build_start": {
      settings = { ...settings, ...(p.settings as BuildSettings) };
      buildDeadline = p.deadline as number;
      enterBuild("online");
      break;
    }
    case "match_countdown": {
      const blueprints = p.blueprints as (Blueprint | null)[];
      const bpA = blueprints[0] ? migrateBlueprint(blueprints[0]) : null;
      const bpB = blueprints[1] ? migrateBlueprint(blueprints[1]) : null;
      if (!bpA || !bpB) {
        message("Opponent blueprint invalid");
        return;
      }
      isAuthority = p.authority === mySlot;
      startCombat(bpA, bpB, (p.seed as number) >>> 0, arena(p.arena as string), p.startAt as number);
      break;
    }
    case "input_frame": {
      const slot = p.slot as number;
      remoteInput[slot] = {
        throttle: p.throttle as number,
        steer: p.steer as number,
        fire: !!p.fire,
        lift: !!p.lift,
      };
      break;
    }
    case "snapshot": {
      if (sim && !isAuthority) {
        sim.applySnapshot(p.data as number[], 0.25);
      }
      break;
    }
    case "checksum": {
      const hash = p.hash as string;
      if (p.slot !== mySlot && hash && lastChecksumPeer && hash !== lastChecksumPeer) {
        desyncWarnings++;
      }
      if (p.slot !== mySlot) lastChecksumPeer = hash;
      break;
    }
    case "peer_disconnected":
      message(`Peer disconnected — ${p.graceSec}s to reconnect`);
      break;
    case "peer_reconnected":
      message("Peer reconnected");
      break;
    case "result": {
      const winner = p.winner as number | null;
      showResult(winner === null ? null : winner === mySlot, p.reason as string);
      break;
    }
    case "error":
      message(`Relay: ${p.message ?? p.code}`);
      break;
    default:
      break; // unknown types ignored
  }
}

function renderLobby(state: Record<string, unknown>) {
  $("lobby-code").textContent = (state.code as string) ?? "—";
  const players = (state.players as ({ name: string; ready: boolean } | null)[]) ?? [null, null];
  for (let i = 0; i < 2; i++) {
    const el = $(`lobby-p${i}`);
    const pl = players[i];
    el.innerHTML = pl
      ? `<div class="name">${pl.name}${i === mySlot ? " (you)" : ""}${i === 0 ? " [host]" : ""}</div><div class="hint">${pl.ready ? "ready" : "not ready"}</div>`
      : `<div class="hint">waiting…</div>`;
  }
  const s = state.settings as BuildSettings;
  const phase = state.phase as string;
  const host = mySlot === 0 && phase === "lobby";
  $("lobby-settings").innerHTML = renderSettingsEditor(s, host);
  if (host) bindSettingsEditor();
  ($("btn-ready") as HTMLButtonElement).disabled = phase !== "lobby" || !players[1 - mySlot];
  $("lobby-hint").textContent =
    phase === "lobby"
      ? players[1 - mySlot]
        ? "Both ready → build phase starts."
        : "Waiting for an opponent to join…"
      : phase === "build"
        ? "Build phase active."
        : `Phase: ${phase}`;
}

function renderSettingsEditor(s: BuildSettings, editable: boolean): string {
  const arenaOpts = Object.values(ARENAS)
    .map((a) => `<option value="${a.id}" ${s.arena === a.id ? "selected" : ""}>${a.name}</option>`)
    .join("");
  const budgetOpts = BUDGET_PRESETS.map(
    (b) => `<option value="${b.sp}" ${s.budgetSp === b.sp ? "selected" : ""}>${b.name} (${b.sp} SP)</option>`,
  ).join("");
  const dis = editable ? "" : "disabled";
  return `
    <div class="setting-row"><span>Build time</span><input id="set-build" type="number" min="60" max="900" step="30" value="${s.buildTimeSec}" ${dis}></div>
    <div class="setting-row"><span>Scrap budget</span><select id="set-budget" ${dis}>${budgetOpts}</select></div>
    <div class="setting-row"><span>Arena</span><select id="set-arena" ${dis}>${arenaOpts}</select></div>
    <div class="setting-row"><span>Combat limit</span><input id="set-combat" type="number" min="120" max="600" step="60" value="${s.combatLimitSec}" ${dis}></div>
    <div class="setting-row"><span>Part limit</span><input id="set-parts" type="number" min="30" max="120" step="30" value="${s.partLimit}" ${dis}></div>
  `;
}

function bindSettingsEditor() {
  const send = () => {
    relay?.send("set_settings", {
      buildTimeSec: parseInt(($("set-build") as HTMLInputElement).value, 10),
      budgetSp: parseInt(($("set-budget") as HTMLSelectElement).value, 10),
      arena: ($("set-arena") as HTMLSelectElement).value,
      combatLimitSec: parseInt(($("set-combat") as HTMLInputElement).value, 10),
      partLimit: parseInt(($("set-parts") as HTMLInputElement).value, 10),
    });
  };
  for (const id of ["set-build", "set-budget", "set-arena", "set-combat", "set-parts"]) {
    $(id).addEventListener("change", send);
  }
}

function leaveOnline() {
  relay?.close();
  relay = null;
  roomCode = null;
  show("menu");
}

// ---------------------------------------------------------------------------
// build phase

let activeCategory: PartCategory = "frame";

function bindBuildUi() {
  // parts bin tabs
  const tabs = $("bin-tabs");
  for (const c of CATEGORIES) {
    const b = document.createElement("button");
    b.textContent = c.name;
    b.onclick = () => {
      activeCategory = c.id;
      renderBin();
    };
    b.dataset.cat = c.id;
    tabs.appendChild(b);
  }
  renderBin();
}

function renderBin() {
  const items = $("bin-items");
  items.innerHTML = "";
  for (const b of $("bin-tabs").querySelectorAll("button")) {
    b.classList.toggle("active", (b.dataset.cat as PartCategory) === activeCategory);
  }
  for (const def of PART_LIST) {
    if (def.category !== activeCategory) continue;
    const div = document.createElement("div");
    div.className = "bin-item";
    div.innerHTML = `<div class="bin-name">${def.name}</div>
      <div class="bin-meta">${def.cost} SP · ${def.mass} kg · ${def.hp} hp</div>
      <div class="bin-desc">${def.desc}</div>`;
    div.onclick = () => {
      editor?.setPlaceDef(def.id);
      for (const el of items.querySelectorAll(".bin-item")) el.classList.remove("active");
      div.classList.add("active");
    };
    items.appendChild(div);
  }
}

function enterBuild(m: Mode) {
  mode = m;
  show("build");
  testing = false;
  testSnapshot = null;
  sim?.destroy();
  sim = null;
  renderer?.clearRobots();
  renderer?.buildArena(arena("foundry"));
  orbit?.setTarget(0, 0.6, 0);

  const saveKey = mode === "online" ? `scrap_bp_autosave_p${mySlot}` : "scrap_bp_autosave_p1";
  editor?.dispose();
  editor = new BuildEditor(renderer!.scene, renderer!.camera, canvas, {
    onChange: updateBuildHud,
    onSelect: updateInspector,
    onMessage: message,
  }, saveKey);
  editor.budgetSp = settings.budgetSp;
  editor.partLimit = settings.partLimit;
  updateBuildHud(editor.getBlueprintSnapshot(), null);
  renderControlsPanel();

  if (mode === "online") {
    $("build-timer").parentElement!.classList.remove("hidden");
    $("btn-lock").classList.remove("hidden");
  } else {
    buildDeadline = 0;
  }
}

function updateBuildHud(bp: Blueprint, stats: unknown) {
  if (!editor) return;
  const cost = blueprintCost(bp);
  $("build-budget").textContent = `SP ${cost}/${settings.budgetSp}`;
  $("build-budget").classList.toggle("warn", cost > settings.budgetSp);
  $("build-parts").textContent = `${bp.parts.length}/${settings.partLimit} parts`;
  const mass = bp.parts.reduce((s, p) => s + (PART_DEFS[p.defId]?.mass ?? 0), 0);
  $("build-mass").textContent = `${mass.toFixed(0)} kg`;
  renderControlsPanel();
  const st = stats as { issues?: { severity: string; message: string }[] } | null;
  lastIssues = st?.issues ?? [];
  renderPreflight();
}

let lastIssues: { severity: string; message: string }[] = [];

function renderPreflight() {
  const el = $("preflight");
  if (!lastIssues.length) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = lastIssues.map((i) => `<div class="${i.severity}">⚠ ${i.message}</div>`).join("");
}

function updateInspector(partId: string | null) {
  const el = $("insp-body");
  if (!partId || !editor) {
    el.innerHTML = "Select a part…";
    return;
  }
  const part = editor.bp.parts.find((p) => p.id === partId);
  if (!part) return;
  const def = PART_DEFS[part.defId];
  if (!def) return;
  const wires = editor.bp.wires.filter((w) => w.from === partId || w.to === partId).length;
  const channels: InputChannel[] = ["throttle", "steer", "fire", "lift"];
  const bound = editor.bp.bindings.filter((b) => b.targetPartId === partId).map((b) => b.channel);
  el.innerHTML = `
    <div class="kv"><span>Part</span><span class="v">${def.name}</span></div>
    <div class="kv"><span>Cost</span><span class="v">${def.cost} SP</span></div>
    <div class="kv"><span>Mass</span><span class="v">${def.mass} kg</span></div>
    <div class="kv"><span>Health</span><span class="v">${def.hp}</span></div>
    <div class="kv"><span>Wires</span><span class="v">${wires}</span></div>
    <div class="kv"><span>Bound</span><span class="v">${bound.join(", ") || "—"}</span></div>
    <div style="margin-top:8px">
      ${def.motor || def.weapon || def.lifter
        ? channels.map((ch) => `<span class="chip ${bound.includes(ch) ? "on" : ""}" data-ch="${ch}" data-part="${partId}">${ch}</span>`).join(" ")
        : ""}
    </div>`;
  for (const chip of el.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      const ch = (chip as HTMLElement).dataset.ch as InputChannel;
      editor?.setBinding(partId, ch, !bound.includes(ch));
      updateInspector(partId);
    });
  }
}

function renderControlsPanel() {
  if (!editor) return;
  const el = $("controls-body");
  const devices = editor.bp.parts.filter((p) => {
    const d = PART_DEFS[p.defId];
    return d && (d.motor || d.weapon || d.lifter);
  });
  if (!devices.length) {
    el.innerHTML = `<div class="hint">No controllable devices yet. Add a motor or weapon.</div>`;
    return;
  }
  const channels: InputChannel[] = ["throttle", "steer", "fire", "lift"];
  el.innerHTML = devices
    .map((p) => {
      const def = PART_DEFS[p.defId]!;
      const bound = editor!.bp.bindings.filter((b) => b.targetPartId === p.id).map((b) => b.channel);
      return `<div class="device"><span>${def.name}</span><span class="chips">${channels
        .map(
          (ch) =>
            `<span class="chip ${bound.includes(ch) ? "on" : ""}" data-ch="${ch}" data-part="${p.id}">${ch.slice(0, 2)}</span>`,
        )
        .join("")}</span></div>`;
    })
    .join("");
  for (const chip of el.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      const elc = chip as HTMLElement;
      const ch = elc.dataset.ch as InputChannel;
      const partId = elc.dataset.part!;
      const on = !elc.classList.contains("on");
      editor?.setBinding(partId, ch, on);
    });
  }
}

function toggleTest() {
  if (!editor || !sim) return;
  if (!testing) startTest();
  else endTest();
}

function startTest() {
  if (!editor || !renderer) return;
  const bp = editor.getBlueprintSnapshot();
  if (!bp.parts.length) {
    message("Nothing to test — place some parts first");
    return;
  }
  testSnapshot = JSON.stringify(bp);
  testing = true;
  $("btn-test").textContent = "■ End Test";
  // test world: player robot only + a dummy target block robot
  const dummy = dummyBlueprint();
  startSimWorld(bp, dummy, ARENAS.grid!, 1337, true);
  message("Test Bay active — build is read-only. End Test restores your build exactly.");
}

function dummyBlueprint(): Blueprint {
  return {
    schemaVersion: 1,
    id: "dummy",
    name: "Target Dummy",
    parts: [
      { id: "d1", defId: "frame_tube", pos: [0, 0, 0], rot: 0 },
      { id: "d2", defId: "armor_steel", pos: [0, 1, 0], rot: 0 },
    ],
    wires: [],
    bindings: [],
  };
}

function endTest() {
  if (!editor) return;
  testing = false;
  $("btn-test").textContent = "▶ Test";
  sim?.destroy();
  sim = null;
  renderer?.clearRobots();
  // restore the exact pre-test blueprint
  if (testSnapshot) {
    const bp = migrateBlueprint(JSON.parse(testSnapshot));
    if (bp) editor.loadBlueprint(bp);
  }
  testSnapshot = null;
  message("End Test — build restored from pre-test snapshot");
}

function onLockIn() {
  if (!editor) return;
  if (testing) endTest();
  const bp = editor.getBlueprintSnapshot();
  // preflight blockers
  if (!bp.parts.some((p) => PART_DEFS[p.defId]?.id === "control_core")) {
    message("Blocker: no Control Core");
    return;
  }
  const cost = blueprintCost(bp);
  if (cost > settings.budgetSp) {
    message(`Over budget: ${cost}/${settings.budgetSp} SP`);
    return;
  }
  if (bp.parts.length > settings.partLimit) {
    message(`Over part limit: ${bp.parts.length}/${settings.partLimit}`);
    return;
  }
  // floating parts check: every part must share a face with another part
  const floating = bp.parts.find(
    (p) => !bp.parts.some((q) => q !== p && isAdjacent(p.pos, q.pos)),
  );
  if (floating) {
    message("Blocker: detached part not attached to the assembly");
    return;
  }
  const hash = blueprintHash(bp);
  if (mode === "online") {
    relay?.send("lock_blueprint", { hash, blueprint: bp });
    message("Blueprint locked. Waiting for opponent…");
    ($("btn-lock") as HTMLButtonElement).disabled = true;
  } else {
    // solo: countdown then fight the AI
    const seed = (Date.now() ^ 0x9e3779b9) >>> 0;
    isAuthority = true;
    startCombat(bp, buildAiBot(), seed, arena(settings.arena), Date.now() + 3000);
  }
}

function isAdjacent(a: [number, number, number], b: [number, number, number]): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  const dz = Math.abs(a[2] - b[2]);
  const face = (dx === 1 && dy === 0 && dz === 0) || (dx === 0 && dy === 1 && dz === 0) || (dx === 0 && dy === 0 && dz === 1);
  return face || (dx <= 1 && dy <= 1 && dz <= 1 && dx + dy + dz > 0 && (dx === 0 || dy === 0 || dz === 0) === false);
}

function onLeaveBuild() {
  if (testing) endTest();
  if (mode === "online") {
    leaveOnline();
  } else {
    backToMenu();
  }
}

function backToMenu() {
  sim?.destroy();
  sim = null;
  ai = null;
  renderer?.clearRobots();
  relay?.close();
  relay = null;
  show("menu");
  checkRelay();
}

// ---------------------------------------------------------------------------
// combat

function startSimWorld(bpA: Blueprint, bpB: Blueprint, arena: ArenaDef, seed: number, testMode: boolean) {
  sim?.destroy();
  sim = new MatchSimulation(bpA, bpB, { seed, arena });
  sim.events.onPartDestroyed = () => {};
  renderer?.clearRobots();
  renderer?.buildArena(arena);
  renderer?.syncRobotMeshes(sim);
  orbit?.setTarget(0, 0.8, 0);
  remoteInput = [newRobotInput(), newRobotInput()];
  if (testMode) {
    ai = null;
  }
}

function startCombat(bpA: Blueprint, bpB: Blueprint, seed: number, arena: ArenaDef, startAt: number) {
  show("combat");
  startSimWorld(bpA, bpB, arena, seed, false);
  ai = null;
  if (mode === "solo") {
    ai = new AiController();
  }
  combatDeadline = startAt + settings.combatLimitSec * 1000;
  const cd = $("countdown");
  cd.classList.remove("hidden");
  const iv = window.setInterval(() => {
    const remain = Math.ceil((startAt - Date.now()) / 1000);
    if (remain <= 0) {
      cd.classList.add("hidden");
      window.clearInterval(iv);
    } else {
      cd.textContent = String(remain);
    }
  }, 200);
  desyncWarnings = 0;
  lastChecksumPeer = "";
  $("result-overlay").classList.add("hidden");
}

function showResult(playerWon: boolean | null, reason: string) {
  const el = $("result-overlay");
  $("result-title").textContent = playerWon === null ? "DRAW" : playerWon ? "VICTORY" : "DEFEAT";
  $("result-reason").textContent = reason;
  el.classList.remove("hidden");
  if (mode === "solo") {
    $("btn-rematch").textContent = "Rematch";
  }
}

function onRematch() {
  if (mode === "online") {
    relay?.send("rematch", {});
    $("result-overlay").classList.add("hidden");
  } else {
    // solo: straight back to build
    show("build");
    $("result-overlay").classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// main loop

function frame(now: number) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  input.update();
  if (relay && relay.ws?.readyState === WebSocket.OPEN) {
    pingTimer += dt;
    if (pingTimer > 2) {
      pingTimer = 0;
      relay.ping();
    }
  }

  if (sim) {
    const combatStartAt = combatDeadline - settings.combatLimitSec * 1000;
    const canStep = testing || Date.now() >= combatStartAt;
    if (canStep) {
      // gather inputs
      let inA: RobotInput;
      let inB: RobotInput;
      if (testing) {
        inA = { throttle: input.throttle, steer: input.steer, fire: input.fire, lift: input.lift };
        inB = newRobotInput();
      } else if (mode === "solo") {
        inA = { throttle: input.throttle, steer: input.steer, fire: input.fire, lift: input.lift };
        if (ai) {
          const cmd = ai.update(aiBotPose(1), aiBotPose(0));
          inB = { throttle: cmd.throttle, steer: cmd.steer, fire: cmd.fire, lift: cmd.lift };
        } else {
          inB = newRobotInput();
        }
      } else {
        inA = mySlot === 0 ? { throttle: input.throttle, steer: input.steer, fire: input.fire, lift: input.lift } : remoteInput[0]!;
        inB = mySlot === 1 ? { throttle: input.throttle, steer: input.steer, fire: input.fire, lift: input.lift } : remoteInput[1]!;
      }

      // fixed-step accumulation
      acc += dt;
      let steps = 0;
      while (acc >= TICK_DT && steps < 5) {
        sim.step([inA, inB]);
        acc -= TICK_DT;
        steps++;
        if (sim.outcome) {
          handleOutcome(sim.outcome);
          break;
        }
      }

      // net: send input frames at 30 Hz when online & in combat
      if (mode === "online" && currentScreen === "combat") {
        inputTimer += dt;
        if (inputTimer > 1 / 30) {
          inputTimer = 0;
          relay?.send("input_frame", { tick: sim.tick, throttle: input.throttle, steer: input.steer, fire: input.fire, lift: input.lift });
        }
        if (isAuthority) {
          snapshotTimer += dt;
          if (snapshotTimer > 1 / 10) {
            snapshotTimer = 0;
            relay?.send("snapshot", { tick: sim.tick, data: sim.snapshot() });
          }
        }
        checksumTimer += dt;
        if (checksumTimer > 1) {
          checksumTimer = 0;
          const h = sim.checksum();
          relay?.send("checksum", { tick: sim.tick, hash: h });
          lastChecksumPeer = lastChecksumPeer; // peer hash handled in message handler
        }
      }

      renderer.syncRobotMeshes(sim);
      renderer.updateFromSim(sim);
      updateCombatHud();
    }
  }
  if (currentScreen === "build" && buildDeadline > 0) {
    const remain = Math.max(0, buildDeadline - Date.now());
    const mm = Math.floor(remain / 60000);
    const ss = Math.floor((remain % 60000) / 1000);
    const el = $("build-timer");
    el.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    el.classList.toggle("urgent", remain < 30000);
    if (remain === 0 && mode === "online" && !testing) {
      // deadline: auto lock what we have
      onLockIn();
    }
  }

  renderer.renderFrame();
}

function aiBotPose(side: number): { x: number; z: number; yaw: number } {
  if (!sim) return { x: 0, z: 0, yaw: 0 };
  const rt = sim.robots[side]!;
  let x = 0;
  let z = 0;
  let n = 0;
  for (const p of rt.parts.values()) {
    if (p.destroyed) continue;
    const t = p.body.translation();
    x += t.x;
    z += t.z;
    n++;
  }
  if (n) {
    x /= n;
    z /= n;
  }
  return { x, z, yaw: side === 1 ? 0 : Math.PI };
}

function updateCombatHud() {
  if (!sim) return;
  for (let side = 0; side < 2; side++) {
    const el = $(`status-p${side}`);
    const info = sim.debugInfo().robots[side]!;
    const name = side === 0 ? (mode === "online" ? `P${mySlot === 0 ? "You" : "1"}` : "You") : mode === "online" ? (mySlot === 1 ? "You" : "P2") : "AI";
    const chargePct = Math.round(info.charge * 100);
    const heatPct = info.hottest ? Math.min(100, Math.round((info.hottest.temp / 170) * 100)) : 0;
    const cond = [];
    cond.push(info.mobility ? '<span class="ok">MOBILE</span>' : '<span class="bad">NO MOBILITY</span>');
    cond.push(info.offense ? '<span class="ok">ARMED</span>' : '<span class="bad">UNARMED</span>');
    cond.push(info.control ? '<span class="ok">CTRL</span>' : '<span class="bad">NO CTRL</span>');
    el.innerHTML = `
      <div class="name">${name} · ${info.mass.toFixed(0)}kg · ${info.partsAlive}/${info.partsTotal} parts</div>
      <div class="bar"><div style="width:${chargePct}%" class="${chargePct < 20 ? "low" : ""}"></div></div>
      <div class="bar"><div class="heat ${heatPct > 65 ? "low" : ""}" style="width:${heatPct}%"></div></div>
      <div class="cond">${cond.join(" · ")}</div>`;
  }
  const remain = Math.max(0, combatDeadline - Date.now());
  const mm = Math.floor(remain / 60000);
  const ss = Math.floor((remain % 60000) / 1000);
  $("combat-timer").textContent = `${mm}:${String(ss).padStart(2, "0")}`;

  if (debugVisible) {
    const info = sim.debugInfo();
    $("debug-overlay").textContent =
      `tick ${info.tick} · ping ${ping ? "?" : "—"}\n` +
      `authority: ${isAuthority ? "yes" : "no"} · desync warnings: ${desyncWarnings}\n` +
      info.robots
        .map(
          (r, i) =>
            `r${i}: ${r.mass.toFixed(0)}kg chg ${(r.charge * 100).toFixed(0)}% dem ${r.demandW.toFixed(0)}W del ${r.deliveredW.toFixed(0)}W hot ${r.hottest ? `${r.hottest.temp.toFixed(0)}°C` : "—"} [${r.mobility ? "M" : "-"}${r.offense ? "O" : "-"}${r.control ? "C" : "-"}] ko-t ${r.destroyedTimer.toFixed(1)}`,
        )
        .join("\n");
  }
}

function handleOutcome(outcome: NonNullable<MatchSimulation["outcome"]>) {
  if (outcome.kind === "timeout") {
    showResult(null, "Time limit — draw");
  } else if (outcome.kind === "ko") {
    if (mode === "online") {
      showResult(outcome.winner === null ? null : outcome.winner === mySlot, outcome.reason);
    } else {
      showResult(outcome.winner === null ? null : outcome.winner === 0, outcome.reason);
    }
    if (mode === "online") relay?.send("checksum", { tick: sim!.tick, hash: sim!.checksum() });
  }
}

boot().catch((err) => {
  const el = document.createElement("pre");
  el.style.cssText = "position:fixed;top:10px;left:10px;color:#f66;z-index:99;white-space:pre-wrap;";
  el.textContent = `Boot failed: ${err}`;
  document.body.appendChild(el);
  throw err;
});
