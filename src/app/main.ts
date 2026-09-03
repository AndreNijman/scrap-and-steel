// SCRAP AND STEEL — app/main.ts
// Boot, screen state machine, game loop, audio/visual game-feel, HUD.
// Rendering stays outside any UI re-render cycle; the DOM is the only UI store.

import { initPhysics } from "../sim/adapter";
import { MatchSimulation, TICK_DT } from "../sim/simulation";
import { newRobotInput, type RobotInput } from "../sim/robot";
import { GameRenderer, OrbitCam, type QualityTier } from "../render/scene";
import { Particles } from "../render/particles";
import { BuildEditor } from "../editor/editor";
import { InputState } from "../control/input";
import { PART_DEFS, PART_LIST, CATEGORIES, ARENAS, BUDGET_PRESETS, type PartCategory } from "../content/parts";
import { DEFAULT_SETTINGS, type Blueprint, type BuildSettings, type InputChannel, blueprintCost } from "../blueprint/types";
import { blueprintHash } from "../blueprint/canonical";
import { RelayClient, resolveRelayUrl } from "../net/client";
import { GAME_VERSION, PROTOCOL_VERSION } from "../../shared/protocol";
import { buildAiBot, AiController } from "../combat/ai";
import { migrateBlueprint } from "../blueprint/types";
import { initAudio, sfx, setVolume, getVolume, setMuted, isMuted, updateDriveSound, updateWeaponSound, stopLoops } from "../audio/sfx";

type Screen = "menu" | "lobby" | "build" | "combat";
type Mode = "solo" | "test" | "online";

const $ = (id: string) => document.getElementById(id)!;

let currentScreen: Screen = "menu";
let mode: Mode = "solo";
let sim: MatchSimulation | null = null;
let renderer: GameRenderer | null = null;
let particles: Particles | null = null;
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
let lastFrame = 0;
let acc = 0;
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
let outcomeBeat = 0; // slow-mo beat after a KO
let outcomeStepGate = 0;
let shakeEnabled = true;
let countdownLast = -1;

interface PersistedPrefs {
  quality: QualityTier | "auto";
  shake: boolean;
}
function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem("scrap_prefs_v1");
    if (raw) return { quality: "auto", shake: true, ...JSON.parse(raw) };
  } catch {
    // fall through
  }
  return { quality: "auto", shake: true };
}
let prefs: PersistedPrefs = loadPrefs();

const canvas = $("gl") as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// helpers

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

function arena(id: string) {
  return ARENAS[id] ?? ARENAS.foundry!;
}

function bootFail(msg: string) {
  $("boot-status").textContent = "";
  const err = $("boot-error");
  err.textContent = msg;
  err.classList.remove("hidden");
  ($("boot-fill") as HTMLElement).style.width = "100%";
  ($("boot-fill") as HTMLElement).style.background = "var(--bad)";
}

function bootStatus(text: string, frac: number) {
  $("boot-status").textContent = text;
  ($("boot-fill") as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
}

// ---------------------------------------------------------------------------
// boot

async function boot() {
  $("ver-text").textContent = `v${GAME_VERSION} · protocol v${PROTOCOL_VERSION}`;

  bootStatus("Waking the foundry…", 0.1);
  // WebGL compatibility gate (release gate: explicit notice, not a blank screen)
  const glProbe = document.createElement("canvas");
  const glOk = !!(glProbe.getContext("webgl2") ?? glProbe.getContext("webgl"));
  if (!glOk) {
    bootFail("Your browser does not support WebGL, which this game requires. Try a current version of Firefox or Chromium.");
    return;
  }

  bootStatus("Compiling physics core…", 0.25);
  renderer = new GameRenderer(canvas);
  particles = new Particles(renderer.scene);
  applyQuality(prefs.quality);
  orbit = new OrbitCam(renderer.camera, canvas);
  input = new InputState();

  bootStatus("Spinning up the arena…", 0.6);
  await initPhysics();

  // menu background: lit arena with a slow orbiting camera
  renderer.buildArena(arena("foundry"));
  orbit.autoRotate = true;
  orbit.setRadius(15);
  orbit.setPhi(1.05);

  bootStatus("Connecting to relay…", 0.9);
  checkRelay();
  bindMenu();
  bindBuildUi();
  bindSettingsModal();
  bindAudioHooks();

  window.addEventListener("resize", resize);
  resize();
  window.setTimeout(() => {
    $("boot").classList.add("done");
    show("menu");
    if (window.innerWidth < 900) {
      message;
    }
  }, 350);
  requestAnimationFrame(frame);
}

function applyQuality(q: QualityTier | "auto") {
  prefs.quality = q;
  persistPrefs();
  let tier: QualityTier = q === "auto" ? (navigator.hardwareConcurrency >= 8 ? "high" : "medium") : q;
  renderer?.setQuality(tier);
}

function persistPrefs() {
  try {
    localStorage.setItem("scrap_prefs_v1", JSON.stringify(prefs));
  } catch {
    // non-fatal
  }
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
// audio hooks

function bindAudioHooks() {
  const unlock = () => initAudio();
  window.addEventListener("pointerdown", unlock, { once: false });
  window.addEventListener("keydown", unlock, { once: false });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLButtonElement) sfx.uiClick();
  });
  document.addEventListener("pointerenter", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLButtonElement) sfx.uiHover();
  }, true);
}

// ---------------------------------------------------------------------------
// settings modal

function bindSettingsModal() {
  $("btn-settings").onclick = () => {
    openModal(`
      <h3>Settings</h3>
      <div class="setting-row"><span>Graphics quality</span>
        <select id="set-quality">
          <option value="auto" ${prefs.quality === "auto" ? "selected" : ""}>Auto</option>
          <option value="low" ${prefs.quality === "low" ? "selected" : ""}>Low</option>
          <option value="medium" ${prefs.quality === "medium" ? "selected" : ""}>Medium</option>
          <option value="high" ${prefs.quality === "high" ? "selected" : ""}>High</option>
        </select>
      </div>
      <div class="setting-row"><span>Volume</span>
        <input id="set-volume" type="range" min="0" max="100" value="${Math.round(getVolume() * 100)}" style="width:140px">
      </div>
      <div class="setting-row"><span>Mute</span><input id="set-mute" type="checkbox" ${isMuted() ? "checked" : ""}></div>
      <div class="setting-row"><span>Camera shake</span><input id="set-shake" type="checkbox" ${prefs.shake ? "checked" : ""}></div>
      <p class="hint" style="margin-top:10px">All gameplay keys are remappable — see How to play.</p>
      <div class="row"><button class="big" id="settings-close">Done</button></div>
    `);
    $("set-quality").addEventListener("change", (e) => applyQuality((e.target as HTMLSelectElement).value as QualityTier | "auto"));
    $("set-volume").addEventListener("input", (e) => {
      initAudio();
      setVolume(parseInt((e.target as HTMLInputElement).value, 10) / 100);
    });
    $("set-mute").addEventListener("change", (e) => setMuted((e.target as HTMLInputElement).checked));
    $("set-shake").addEventListener("change", (e) => {
      prefs.shake = (e.target as HTMLInputElement).checked;
      persistPrefs();
      shakeEnabled = prefs.shake;
    });
    $("settings-close").onclick = closeModal;
  };
}

// ---------------------------------------------------------------------------
// menu

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
      <li><b>Wire:</b> switch to the Wire tool and click battery → motor/weapon. No wire, no power. Wire color shows its gauge.</li>
      <li><b>Controls:</b> motors are auto-bound to W/S/A/D. Weapons fire with Space. The yellow ring in the floor marks your center of mass.</li>
      <li><b>Test:</b> Start Test simulates your robot with real physics. End Test restores your build exactly.</li>
      <li><b>Fight:</b> a robot dies when it can no longer move <i>and</i> cannot attack — for 3 straight seconds. An empty battery is not death; keep hitting them.</li>
      <li><b>Online:</b> create a room, share the code, both Ready → 7-minute build (server clock), lock in, fight.</li>
    </ul>
    <div class="row"><button class="big" id="help-close">Got it</button></div>
  `);
  $("help-close").onclick = closeModal;
}

function promptJoin() {
  openModal(`
    <h3>Join a room</h3>
    <p>Enter the 5-letter room code:</p>
    <p><input id="join-code" maxlength="5" placeholder="ABCDE" /></p>
    <div class="row">
      <button class="big" id="do-join">Join</button>
      <button class="small" id="join-cancel">Cancel</button>
    </div>
  `);
  $("do-join").onclick = () => {
    const code = ($("join-code") as HTMLInputElement).value.trim().toUpperCase();
    if (code.length >= 4) {
      closeModal();
      connectOnline(`code=${code}`);
    }
  };
  $("join-cancel").onclick = closeModal;
  $("join-code").focus();
}

function openModal(html: string) {
  $("modal-content").innerHTML = html;
  $("modal").classList.remove("hidden");
}

function closeModal() {
  $("modal").classList.add("hidden");
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
    case "pong": {
      if (typeof p.t === "number") ping = Date.now() - (p.t as number);
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
  backToMenu();
}

// ---------------------------------------------------------------------------
// build phase

let activeCategory: PartCategory = "frame";

function bindBuildUi() {
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
  stopLoops();
  particles?.clear();
  renderer?.clearRobots();
  renderer?.buildArena(arena("foundry"));
  orbit!.autoRotate = false;
  orbit?.setTarget(0, 0.6, 0);

  const saveKey = mode === "online" ? `scrap_bp_autosave_p${mySlot}` : "scrap_bp_autosave_p1";
  editor?.dispose();
  editor = new BuildEditor(renderer!.scene, renderer!.camera, canvas, {
    onChange: updateBuildHud,
    onSelect: updateInspector,
    onMessage: message,
    onAction: (a) => {
      if (a === "place") sfx.place();
      else if (a === "delete") sfx.delete();
      else if (a === "wire") sfx.wire();
      else sfx.uiClick();
    },
  }, saveKey);
  editor.budgetSp = settings.budgetSp;
  editor.partLimit = settings.partLimit;
  updateBuildHud(editor.getBlueprintSnapshot(), null);
  $("bp-name").textContent = editor.bp.name;

  if (mode === "online") {
    buildDeadline = buildDeadline > 0 ? buildDeadline : Date.now() + settings.buildTimeSec * 1000;
  } else {
    buildDeadline = 0;
    $("build-timer").textContent = "∞";
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
  // peak power estimate: sum of peak draws of installed actuators
  let peak = 0;
  for (const p of bp.parts) {
    const d = PART_DEFS[p.defId];
    if (d?.motor) peak += d.motor.peakW;
    if (d?.weapon) peak += d.weapon.peakW;
    if (d?.lifter) peak += d.lifter.peakW;
  }
  $("build-power").textContent = `${(peak / 1000).toFixed(1)} kW peak`;
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
  $("test-banner").classList.remove("hidden");
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
  $("test-banner").classList.add("hidden");
  sim?.destroy();
  sim = null;
  stopLoops();
  particles?.clear();
  renderer?.clearRobots();
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
  const floating = bp.parts.find((p) => !bp.parts.some((q) => q !== p && isAdjacent(p.pos, q.pos)));
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
    const seed = (Date.now() ^ 0x9e3779b9) >>> 0;
    isAuthority = true;
    startCombat(bp, buildAiBot(), seed, arena(settings.arena), Date.now() + 3000);
  }
}

function isAdjacent(a: [number, number, number], b: [number, number, number]): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  const dz = Math.abs(a[2] - b[2]);
  return (dx === 1 && dy === 0 && dz === 0) || (dx === 0 && dy === 1 && dz === 0) || (dx === 0 && dy === 0 && dz === 1);
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
  stopLoops();
  particles?.clear();
  renderer?.clearRobots();
  renderer?.buildArena(arena("foundry"));
  orbit!.autoRotate = true;
  orbit!.setRadius(15);
  relay?.close();
  relay = null;
  show("menu");
  checkRelay();
}

// ---------------------------------------------------------------------------
// combat sim event positions (plain xyz for the particle system)

const tmpVec = { x: 0, y: 0, z: 0 };
function partPos(side: number, partId: string): { x: number; y: number; z: number } | null {
  const p = sim?.robots[side]?.parts.get(partId);
  if (!p) return null;
  const t = p.body.translation();
  tmpVec.x = t.x; tmpVec.y = t.y; tmpVec.z = t.z;
  return tmpVec;
}

function startSimWorld(bpA: Blueprint, bpB: Blueprint, arenaDef: ReturnType<typeof arena>, seed: number, testMode: boolean) {
  sim?.destroy();
  sim = new MatchSimulation(bpA, bpB, { seed, arena: arenaDef });
  sim.events.onBigHit = (side, partId, force) => {
    const frac = Math.min(1, force / 25000);
    sfx.hit(frac);
    const pos = partPos(side, partId);
    if (pos && particles) particles.sparks(pos, Math.round(6 + frac * 18), 0.6 + frac);
    if (shakeEnabled && renderer) renderer.addShake(0.1 + frac * 0.3);
  };
  sim.events.onPartDestroyed = (side, partId) => {
    sfx.explode();
    const pos = partPos(side, partId);
    if (pos && particles) particles.explosion(pos);
    if (shakeEnabled && renderer) renderer.addShake(0.4);
  };
  sim.events.onWeldBroken = () => {
    sfx.weldBreak();
  };
  renderer?.clearRobots();
  renderer?.buildArena(arenaDef);
  renderer?.syncRobotMeshes(sim);
  orbit?.setTarget(0, 0.8, 0);
  remoteInput = [newRobotInput(), newRobotInput()];
  if (testMode) ai = null;
}

function startCombat(bpA: Blueprint, bpB: Blueprint, seed: number, arenaDef: ReturnType<typeof arena>, startAt: number) {
  show("combat");
  startSimWorld(bpA, bpB, arenaDef, seed, false);
  ai = mode === "solo" ? new AiController() : null;
  combatDeadline = startAt + settings.combatLimitSec * 1000;
  outcomeBeat = 0;
  resultShown = false;
  pendingOutcome = null;
  desyncWarnings = 0;
  lastChecksumPeer = "";
  countdownLast = -1;
  $("result-overlay").classList.add("hidden");
  $("ko-banner").classList.add("hidden");
  $("combat-phase").textContent = mode === "online" ? `ONLINE · ROOM ${roomCode ?? "—"}` : "SOLO VS AI";
  const cd = $("countdown");
  cd.classList.remove("hidden");
  const iv = window.setInterval(() => {
    const remain = Math.ceil((startAt - Date.now()) / 1000);
    if (remain <= 0) {
      cd.classList.add("hidden");
      window.clearInterval(iv);
    } else {
      if (remain !== countdownLast) {
        countdownLast = remain;
        sfx.countdown(remain <= 1);
      }
      cd.textContent = String(remain);
    }
  }, 150);
}

function showResult(playerWon: boolean | null, reason: string) {
  stopLoops();
  const banner = $("result-banner");
  banner.classList.remove("win", "lose", "draw");
  if (playerWon === null) banner.classList.add("draw");
  else banner.classList.add(playerWon ? "win" : "lose");
  banner.textContent = playerWon === null ? "DRAW" : playerWon ? "VICTORY" : "DEFEAT";
  $("result-reason").textContent = reason;
  // match stats
  const dur = sim ? sim.tick / 60 : 0;
  const mm = Math.floor(dur / 60);
  const ss = Math.floor(dur % 60);
  const lost = sim ? sim.destroyedCount : [0, 0];
  $("result-stats").innerHTML = `
    <span><b>${mm}:${String(ss).padStart(2, "0")}</b>time</span>
    <span><b>${lost[0]}</b>your parts lost</span>
    <span><b>${lost[1]}</b>enemy parts lost</span>`;
  $("result-overlay").classList.remove("hidden");
  if (playerWon === null) sfx.draw();
  else if (playerWon) sfx.victory();
  else sfx.defeat();
}

function onRematch() {
  if (mode === "online") {
    relay?.send("rematch", {});
    $("result-overlay").classList.add("hidden");
  } else {
    show("build");
    $("result-overlay").classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// main loop

function frame(now: number) {
  requestAnimationFrame(frame);
  (window as unknown as { __fps: number }).__fps = (window as unknown as { __fps: number }).__fps ? 1 : 1;
  if (!renderer) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  input.update();
  if (orbit?.autoRotate) orbit.update(dt);

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

      // fixed-step accumulation; during the KO beat, quarter-speed steps
      acc += dt;
      const slowmo = outcomeBeat > 0;
      const stepEvery = slowmo ? 4 : 1;
      outcomeStepGate++;
      let steps = 0;
      const maxSteps = slowmo ? 1 : 5;
      if (!slowmo || outcomeStepGate % stepEvery === 0) {
        sim.frozen = slowmo ? false : sim.frozen;
        while (acc >= TICK_DT && steps < maxSteps) {
          sim.step([inA, inB]);
          acc -= TICK_DT;
          steps++;
          if (sim.outcome && !resultShown) {
            beginOutcomeBeat(sim.outcome);
            break;
          }
        }
        if (slowmo) sim.frozen = true;
      } else {
        acc = Math.min(acc, TICK_DT * 2);
      }

      // audio loops for the player robot
      const playerSide = mode === "online" ? mySlot : 0;
      const rt = sim.robots[playerSide];
      if (rt) {
        const inp = playerSide === 0 ? inA : inB;
        updateDriveSound(testing || currentScreen === "combat" ? Math.min(1, Math.abs(inp.throttle) + Math.abs(inp.steer) * 0.5) : 0);
        let spin = 0;
        for (const w of rt.weapons) {
          const target = (w.def.weapon!.spinupRpm * 2 * Math.PI) / 60;
          spin = Math.max(spin, Math.min(1, w.omega / target));
        }
        updateWeaponSound(spin);
      }

      // net: online combat traffic
      if (mode === "online" && currentScreen === "combat" && !slowmo) {
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
          relay?.send("checksum", { tick: sim.tick, hash: sim.checksum() });
        }
      }

      // KO beat timing
      if (slowmo) {
        (window as unknown as { __beat: number }).__beat = outcomeBeat;
        outcomeBeat -= dt;
        if (outcomeBeat <= 0) finishOutcomeBeat();
      }

      renderer.syncRobotMeshes(sim);
      renderer.updateFromSim(sim);
      updateCombatHud();
    }

    // combat camera director: frame both robots
    if (currentScreen === "combat" && !testing) {
      const p0 = aiBotPose(0);
      const p1 = aiBotPose(1);
      const sep = Math.hypot(p0.x - p1.x, p0.z - p1.z);
      const desired = combatCamTarget ?? { x: 0, y: 1.0, z: 0 };
      desired.x += ((p0.x + p1.x) / 2 - desired.x) * Math.min(1, dt * 2.5);
      desired.z += ((p0.z + p1.z) / 2 - desired.z) * Math.min(1, dt * 2.5);
      combatCamTarget = desired;
      orbit?.setTarget(desired.x, 0.9, desired.z);
      const wantRadius = Math.max(7, Math.min(14, 5.5 + sep * 1.1));
      orbit!.setRadius(orbit!.getRadius() + (wantRadius - orbit!.getRadius()) * Math.min(1, dt * 1.5));
    }
  }

  particles?.update(dt);

  // build timer display
  if (currentScreen === "build" && buildDeadline > 0) {
    const remain = Math.max(0, buildDeadline - Date.now());
    const mm = Math.floor(remain / 60000);
    const ss = Math.floor((remain % 60000) / 1000);
    const el = $("build-timer");
    el.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    el.classList.toggle("urgent", remain < 30000);
    if (remain === 0 && mode === "online" && !testing) {
      onLockIn();
    }
  }

  renderer.renderFrame();
}

let combatCamTarget: { x: number; y: number; z: number } | null = null;

function beginOutcomeBeat(outcome: NonNullable<MatchSimulation["outcome"]>) {
  if (resultShown || pendingOutcome) return;
  outcomeBeat = 1.25;
  outcomeStepGate = 0;
  sim!.frozen = true; // gate reopens during the beat
  if (outcome.kind === "ko") {
    $("ko-banner").classList.remove("hidden");
    if (shakeEnabled && renderer) renderer.addShake(0.5);
  }
  // remember final outcome for finishOutcomeBeat
  pendingOutcome = outcome;
}

let pendingOutcome: NonNullable<MatchSimulation["outcome"]> | null = null;
let resultShown = false;

function finishOutcomeBeat() {
  outcomeBeat = 0;
  $("ko-banner").classList.add("hidden");
  const outcome = pendingOutcome;
  pendingOutcome = null;
  if (!outcome || !sim) return;
  sim.frozen = true;
  resultShown = true;
  if (outcome.kind === "timeout") {
    showResult(null, "Time limit — draw");
  } else if (outcome.kind === "ko") {
    if (mode === "online") {
      showResult(outcome.winner === null ? null : outcome.winner === mySlot, outcome.reason);
    } else {
      showResult(outcome.winner === null ? null : outcome.winner === 0, outcome.reason);
    }
  }
}

function aiBotPose(side: number): { x: number; y?: number; z: number; yaw: number } {
  if (!sim) return { x: 0, z: 0, yaw: 0 };
  const rt = sim.robots[side]!;
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  // heading: average forward vector (local +z rotated by each surviving body)
  let fx = 0;
  let fz = 0;
  for (const p of rt.parts.values()) {
    if (p.destroyed) continue;
    const t = p.body.translation();
    const r = p.body.rotation();
    const wx = 2 * (r.x * r.z + r.w * r.y);
    const wz = 1 - 2 * (r.x * r.x + r.y * r.y);
    fx += wx;
    fz += wz;
    x += t.x;
    y += t.y;
    z += t.z;
    n++;
  }
  if (n) {
    x /= n;
    y /= n;
    z /= n;
    fx /= n;
    fz /= n;
  }
  return { x, y, z, yaw: Math.atan2(fx, fz) };
}

function updateCombatHud() {
  if (!sim) return;
  for (let side = 0; side < 2; side++) {
    const el = $(`status-p${side}`);
    const info = sim.debugInfo().robots[side]!;
    const isYou = mode === "online" ? side === mySlot : side === 0;
    const name = mode === "online" ? (isYou ? "YOU" : "RIVAL") : side === 0 ? "YOU" : "SCRAPPER";
    const chargePct = Math.round(info.charge * 100);
    const heatPct = info.hottest ? Math.min(100, Math.round((info.hottest.temp / 170) * 100)) : 0;
    const chip = (ok: boolean, warn = false) => ok ? '<span class="chip-ok">✓</span>' : warn ? '<span class="chip-warn">~</span>' : '<span class="chip-bad">✗</span>';
    el.innerHTML = `
      <div class="name" style="color:${side === 0 ? "#7fd0e8" : "#e8a07f"}">${name} · ${info.mass.toFixed(0)}kg · ${info.partsAlive}/${info.partsTotal}</div>
      <div class="bar"><div style="width:${chargePct}%" class="${chargePct < 20 ? "low" : ""}"></div></div>
      <div class="bar"><div class="heat ${heatPct > 65 ? "low" : ""}" style="width:${heatPct}%"></div></div>
      <div class="cond">MOB ${chip(info.mobility)} · ARM ${chip(info.offense)} · CTRL ${chip(info.control)}${info.destroyedTimer > 0 ? ` · KO ${info.destroyedTimer.toFixed(1)}s` : ""}</div>`;
  }
  const remain = Math.max(0, combatDeadline - Date.now());
  const mm = Math.floor(remain / 60000);
  const ss = Math.floor((remain % 60000) / 1000);
  $("combat-timer").textContent = `${mm}:${String(ss).padStart(2, "0")}`;

  if (debugVisible) {
    const info = sim.debugInfo();
    $("debug-overlay").textContent =
      `tick ${info.tick} · ping ${ping || "—"}ms\n` +
      `authority: ${isAuthority ? "yes" : "no"} · desync warnings: ${desyncWarnings}\n` +
      info.robots
        .map(
          (r, i) =>
            `r${i}: ${r.mass.toFixed(0)}kg chg ${(r.charge * 100).toFixed(0)}% dem ${r.demandW.toFixed(0)}W del ${r.deliveredW.toFixed(0)}W hot ${r.hottest ? `${r.hottest.temp.toFixed(0)}°C` : "—"} [${r.mobility ? "M" : "-"}${r.offense ? "O" : "-"}${r.control ? "C" : "-"}] ko-t ${r.destroyedTimer.toFixed(1)}`,
        )
        .join("\n");
  }
}

// combat deadline timeout → draw (mirrors the Room DO)
setInterval(() => {
  if (sim && !sim.outcome && !resultShown && currentScreen === "combat" && !testing && combatDeadline > 0 && Date.now() >= combatDeadline) {
    sim.frozen = true;
    sim.outcome = { kind: "timeout", winner: null, reason: "time-limit" };
    beginOutcomeBeat(sim.outcome);
  }
}, 250);

boot().catch((err) => {
  bootFail(`Boot failed: ${err}. Try a current version of Firefox or Chromium.`);
  console.error(err);
});
