// SCRAP & STEEL — ui/docsModal.ts
// In-game documentation viewer: Field Manual, Node Circuits, Python API, and Recipes.

export type DocsTab = "manual" | "nodes" | "python" | "recipes";

let currentTab: DocsTab = "manual";

export function getDocsTab(): DocsTab {
  return currentTab;
}

export function openDocsModal(
  tab: DocsTab = "manual",
  onClose?: () => void,
  onCopy?: (text: string) => void
): void {
  currentTab = tab;
  const modal = document.getElementById("modal");
  const content = document.getElementById("modal-content");
  if (!modal || !content) return;

  content.className = "modal-box modal-wide";
  renderDocsContent(content, onClose, onCopy);
  modal.classList.remove("hidden");
}

export function closeDocsModal(): void {
  const modal = document.getElementById("modal");
  const content = document.getElementById("modal-content");
  if (modal) modal.classList.add("hidden");
  if (content) content.className = "modal-box";
}

function renderDocsContent(
  container: HTMLElement,
  onClose?: () => void,
  onCopy?: (text: string) => void
): void {
  container.innerHTML = `
    <div class="docs-header">
      <h3>SCRAP &amp; STEEL MANUAL &amp; REFERENCE</h3>
      <button id="docs-close-btn" class="docs-close-x" title="Close (ESC)">✕</button>
    </div>
    <div class="docs-tabs" role="tablist">
      <button class="docs-tab ${currentTab === "manual" ? "active" : ""}" data-tab="manual">FIELD MANUAL</button>
      <button class="docs-tab ${currentTab === "nodes" ? "active" : ""}" data-tab="nodes">NODE REFERENCE</button>
      <button class="docs-tab ${currentTab === "python" ? "active" : ""}" data-tab="python">PYTHON MANUAL</button>
      <button class="docs-tab ${currentTab === "recipes" ? "active" : ""}" data-tab="recipes">RECIPES &amp; EXAMPLES</button>
    </div>
    <div class="docs-body" id="docs-tab-content">
      ${getTabHtml(currentTab)}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn-primary" id="docs-done-btn">CLOSE</button>
    </div>
  `;

  // Bind close buttons
  const closeAction = () => {
    closeDocsModal();
    onClose?.();
  };
  document.getElementById("docs-close-btn")?.addEventListener("click", closeAction);
  document.getElementById("docs-done-btn")?.addEventListener("click", closeAction);

  // Bind tabs
  const tabBtns = container.querySelectorAll<HTMLButtonElement>(".docs-tab");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab as DocsTab;
      if (target && target !== currentTab) {
        currentTab = target;
        tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === currentTab));
        const tabHost = document.getElementById("docs-tab-content");
        if (tabHost) {
          tabHost.innerHTML = getTabHtml(currentTab);
          bindSnippetButtons(tabHost, onCopy);
        }
      }
    });
  });

  bindSnippetButtons(container, onCopy);
}

function bindSnippetButtons(container: HTMLElement, onCopy?: (text: string) => void): void {
  const copyBtns = container.querySelectorAll<HTMLButtonElement>(".docs-copy-btn");
  copyBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const snippet = btn.getAttribute("data-snippet");
      if (snippet) {
        navigator.clipboard?.writeText(snippet);
        onCopy?.(snippet);
        const originalText = btn.textContent;
        btn.textContent = "COPIED!";
        setTimeout(() => {
          btn.textContent = originalText;
        }, 1500);
      }
    });
  });
}

function getTabHtml(tab: DocsTab): string {
  switch (tab) {
    case "manual":
      return getManualHtml();
    case "nodes":
      return getNodesHtml();
    case "python":
      return getPythonHtml();
    case "recipes":
      return getRecipesHtml();
  }
}

function getManualHtml(): string {
  return `
    <div class="docs-section">
      <h4>WORKSHOP BASICS</h4>
      <p>Assemble mechanical robots on a grid. Each part is an independent rigid body with mass, health, and electrical connections. Physics runs through Planck.js at fixed 60 Hz.</p>
      <table class="docs-table">
        <thead><tr><th>Action</th><th>Key / Control</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td>Place part</td><td><code>1</code> or click <b>PLACE</b></td><td>Click part category, select component, click grid to place.</td></tr>
          <tr><td>Select / Move</td><td><code>2</code> or click <b>SELECT</b></td><td>Click or drag placed components to reposition.</td></tr>
          <tr><td>Wire cables</td><td><code>3</code> or click <b>WIRE</b></td><td>Click start port, then click target port. Orange = power, dark = driveshaft.</td></tr>
          <tr><td>Remove part</td><td><code>4</code> or Right-click</td><td>Deletes part and attached wires.</td></tr>
          <tr><td>Rotate part</td><td><code>R</code></td><td>Rotates selected part 90 degrees clockwise.</td></tr>
          <tr><td>Copy / Paste</td><td><code>Ctrl+C</code> / <code>Ctrl+V</code></td><td>Duplicates selected component to mouse location.</td></tr>
          <tr><td>Undo / Redo</td><td><code>Ctrl+Z</code> / <code>Ctrl+Y</code></td><td>Revert or redo editor modifications.</td></tr>
          <tr><td>Test Mode</td><td><code>T</code> or <b>▶ TEST</b></td><td>Starts physics simulation. Press again to restore pristine snapshot.</td></tr>
          <tr><td>Diagnostics</td><td><code>D</code> or <b>◐ DIAG</b></td><td>Live current flow, voltage drop, and component inspector.</td></tr>
          <tr><td>Open Manual</td><td><code>H</code> or <b>DOCS</b></td><td>Opens this documentation window.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="docs-section">
      <h4>WIRING &amp; POWER RULES</h4>
      <ul>
        <li><b>No Hidden Connections:</b> Power flows only through placed wires. Electric loads (computers, sensors, motors, weapons) shut down without continuous electrical power.</li>
        <li><b>Driveshafts:</b> Motors connect to wheels via mechanical driveshafts. Draw wire from a motor <code>S</code> port to a wheel or track port. A wheel without a coupled motor has no traction force.</li>
        <li><b>Power Distribution:</b> Use batteries, generators, and capacitors. Monitor current draw: excessive current overheats wires and drops bus voltage.</li>
      </ul>
    </div>

    <div class="docs-section">
      <h4>TEST MODE &amp; BATTLE RULES</h4>
      <ul>
        <li><b>Blueprint Immutability:</b> Blueprints are never modified during test mode or battle. On reset, damaged and destroyed parts restore to full health.</li>
        <li><b>Defeat Condition:</b> A robot loses when its microcontroller is destroyed, or when it holds zero mobility AND zero functional weapons for 3 straight seconds.</li>
        <li><b>Battery Depletion:</b> An empty battery is not defeat. A drained robot can still wait for capacitors or solar recharge.</li>
      </ul>
    </div>
  `;
}

function getNodesHtml(): string {
  return `
    <div class="docs-section">
      <h4>VISUAL LOGIC CIRCUITS</h4>
      <p>The logic circuit is evaluated every simulation tick (60 Hz). Add nodes, configure parameters, and connect output ports to input ports to automate robot behavior.</p>
    </div>

    <div class="docs-section">
      <h4>INPUT NODES</h4>
      <table class="docs-table">
        <thead><tr><th>Node</th><th>Inputs</th><th>Outputs</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>INPUT FORWARD</code></td><td>none</td><td><code>val</code></td><td>1 while W (forward key) is held, else 0.</td></tr>
          <tr><td><code>INPUT REVERSE</code></td><td>none</td><td><code>val</code></td><td>1 while S (reverse key) is held, else 0.</td></tr>
          <tr><td><code>INPUT TRIGGER</code></td><td>none</td><td><code>val</code></td><td>1 while Space (fire key) is held, else 0.</td></tr>
          <tr><td><code>INPUT AUX</code></td><td>none</td><td><code>val</code></td><td>1 while Shift (aux key) is held, else 0.</td></tr>
          <tr><td><code>INPUT TURRET</code></td><td>none</td><td><code>val</code></td><td>Axis -1 (Q / CCW) to +1 (E / CW).</td></tr>
          <tr><td><code>SENSOR</code></td><td>none</td><td><code>val</code></td><td>Live reading from selected wired sensor part (gyro, battery, speed, proximity, radar).</td></tr>
          <tr><td><code>CONSTANT</code></td><td>none</td><td><code>val</code></td><td>Configurable constant floating-point number.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="docs-section">
      <h4>MATH &amp; COMPARISON NODES</h4>
      <table class="docs-table">
        <thead><tr><th>Node</th><th>Inputs</th><th>Outputs</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>ADD</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Outputs <code>a + b</code>.</td></tr>
          <tr><td><code>SUBTRACT</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Outputs <code>a - b</code>. Standard for tank drive: <code>forward - reverse</code>.</td></tr>
          <tr><td><code>MULTIPLY</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Outputs <code>a * b</code>.</td></tr>
          <tr><td><code>DIVIDE</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Outputs <code>a / b</code> (returns 0 if b is 0).</td></tr>
          <tr><td><code>ABSOLUTE</code></td><td><code>a</code></td><td><code>val</code></td><td>Outputs <code>|a|</code>.</td></tr>
          <tr><td><code>CLAMP</code></td><td><code>a</code></td><td><code>val</code></td><td>Constrains <code>a</code> between min and max parameters.</td></tr>
          <tr><td><code>GREATER</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>1 if <code>a &gt; b</code>, else 0.</td></tr>
          <tr><td><code>LESS</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>1 if <code>a &lt; b</code>, else 0.</td></tr>
          <tr><td><code>EQUAL</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>1 if <code>|a - b| &lt; 0.001</code>, else 0.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="docs-section">
      <h4>LOGIC &amp; FLOW NODES</h4>
      <table class="docs-table">
        <thead><tr><th>Node</th><th>Inputs</th><th>Outputs</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>AND</code> / <code>OR</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Standard binary boolean logic (non-zero is truthy).</td></tr>
          <tr><td><code>NOT</code> / <code>XOR</code></td><td><code>a</code> / <code>a, b</code></td><td><code>val</code></td><td>Inversion and exclusive OR logic.</td></tr>
          <tr><td><code>IF / ELSE</code> (select)</td><td><code>cond</code>, <code>a</code>, <code>b</code></td><td><code>val</code></td><td>If <code>cond ≠ 0</code> outputs <code>a</code>, else outputs <code>b</code>.</td></tr>
          <tr><td><code>TOGGLE</code></td><td><code>a</code></td><td><code>val</code></td><td>Inverts state between 0 and 1 on rising edge of <code>a</code>.</td></tr>
          <tr><td><code>LATCH</code></td><td><code>a</code>, <code>b</code></td><td><code>val</code></td><td>Signal on <code>a</code> sets output to 1 until signal on <code>b</code> resets.</td></tr>
          <tr><td><code>TIMER</code></td><td>none</td><td><code>val</code></td><td>Square wave oscillating between 1 and 0 for configured seconds.</td></tr>
          <tr><td><code>DELAY</code></td><td><code>a</code></td><td><code>val</code></td><td>Buffers and delays incoming signal by configured seconds.</td></tr>
          <tr><td><code>COUNTER</code></td><td><code>a</code></td><td><code>val</code></td><td>Counts rising edges of <code>a</code>, resetting at wrap limit.</td></tr>
          <tr><td><code>PID</code></td><td><code>target</code>, <code>a</code></td><td><code>val</code></td><td>PID controller: computes correction signal from <code>target - a</code>.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="docs-section">
      <h4>OUTPUT ACTUATOR NODES</h4>
      <table class="docs-table">
        <thead><tr><th>Node</th><th>Inputs</th><th>Target</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>MOTOR POWER</code></td><td><code>val</code></td><td>Motor part</td><td>Drives motor from -1.0 (reverse) to +1.0 (forward) of rated torque.</td></tr>
          <tr><td><code>SERVO TARGET</code></td><td><code>val</code></td><td>Servo / Turret</td><td>Sets target angle in degrees (-90 to +90) or piston extension (0 to 1).</td></tr>
          <tr><td><code>WEAPON TRIGGER</code></td><td><code>val</code></td><td>Weapon part</td><td>Non-zero value triggers firing (requires wired power and ammunition).</td></tr>
          <tr><td><code>BRAKE</code></td><td><code>val</code></td><td>Chassis</td><td>Non-zero value locks all driven wheels to prevent sliding.</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

function getPythonHtml(): string {
  return `
    <div class="docs-section">
      <h4>PYTHON SCRIPTING MODE</h4>
      <p>Instead of a visual node graph, you can write a tick-driven Python program. Switch views using the <b>NODES / PYTHON</b> toggle in the LOGIC CIRCUIT panel header.</p>
      <div class="docs-callout">
        <b>Execution model:</b> Your program runs once every simulation tick (60 Hz). There are no infinite loops or external imports. The program reads inputs, calculates signals, and commands actuators each tick.
      </div>
    </div>

    <div class="docs-section">
      <h4>BUILT-IN ROBOT API</h4>
      <table class="docs-table">
        <thead><tr><th>Function</th><th>Return / Effect</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>forward()</code></td><td><code>float</code> (0 or 1)</td><td>State of W / forward movement key.</td></tr>
          <tr><td><code>back()</code></td><td><code>float</code> (0 or 1)</td><td>State of S / reverse movement key.</td></tr>
          <tr><td><code>fire()</code></td><td><code>float</code> (0 or 1)</td><td>State of Space / fire trigger key.</td></tr>
          <tr><td><code>aux()</code></td><td><code>float</code> (0 or 1)</td><td>State of Shift / auxiliary key.</td></tr>
          <tr><td><code>turret()</code></td><td><code>float</code> (-1 .. 1)</td><td>Turret rotation axis: -1 (Q / CCW) to +1 (E / CW).</td></tr>
          <tr><td><code>sensor(id)</code></td><td><code>float</code></td><td>Live reading of sensor part. Accepts full part ID or 4-character suffix. For radar: <code>"id#bearing"</code> (deg) and <code>"id#range"</code> (m).</td></tr>
          <tr><td><code>motor(id, val)</code></td><td><code>void</code></td><td>Drives motor: <code>val</code> between -1.0 and +1.0 of rated torque.</td></tr>
          <tr><td><code>servo(id, deg)</code></td><td><code>void</code></td><td>Sets angle for servo / turret bearing (-90 to +90 deg), or piston extension (0 to 1).</td></tr>
          <tr><td><code>weapon(id, val)</code></td><td><code>void</code></td><td>Non-zero fires the designated weapon.</td></tr>
          <tr><td><code>brake(val)</code></td><td><code>void</code></td><td>Non-zero locks all wheels.</td></tr>
          <tr><td><code>clamp(v, lo, hi)</code></td><td><code>float</code></td><td>Constrains <code>v</code> between <code>lo</code> and <code>hi</code>.</td></tr>
          <tr><td><code>abs(v)</code></td><td><code>float</code></td><td>Absolute value of <code>v</code>.</td></tr>
          <tr><td><code>min(...)</code> / <code>max(...)</code></td><td><code>float</code></td><td>Smallest or largest number among arguments.</td></tr>
          <tr><td><code>pid(k, tgt, v, kp, ki, kd)</code></td><td><code>float</code></td><td>Stateful PID controller identified by unique key <code>k</code>.</td></tr>
          <tr><td><code>remember(k, v)</code></td><td><code>void</code></td><td>Stores numeric variable <code>k</code> across ticks.</td></tr>
          <tr><td><code>recall(k, fallback)</code></td><td><code>float</code></td><td>Retrieves stored variable <code>k</code>, returning fallback if unset.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="docs-section">
      <h4>SYNTAX &amp; CONSTRAINTS</h4>
      <ul>
        <li><b>Supported:</b> Variable assignments (<code>x = 5</code>), <code>if</code> / <code>elif</code> / <code>else</code>, ternary expressions (<code>x = 1 if ok else 0</code>), comparisons (<code>==</code>, <code>!=</code>, <code>&lt;</code>, <code>&gt;</code>, <code>&lt;=</code>, <code>&gt;=</code>), boolean logic (<code>and</code>, <code>or</code>, <code>not</code>), comments starting with <code>#</code>.</li>
        <li><b>Forbidden:</b> Loops (<code>while</code>, <code>for</code>) and <code>import</code> statements are rejected. Logic must execute within the single 60 Hz tick budget.</li>
        <li><b>Component IDs:</b> Click any part in the workshop to view its ID in the COMPONENT panel. You can use either the full ID or the short 4-character suffix (e.g. <code>"3f8a"</code>).</li>
        <li><b>Resilience:</b> Compile and runtime errors are shown in red beneath the editor. A faulty script never halts the simulation; outputs cleanly default to neutral.</li>
      </ul>
    </div>
  `;
}

function getRecipesHtml(): string {
  const snippets = {
    tankDrive: `# Dual-Motor Forward / Reverse Drive
drive = clamp(forward() - back(), -1, 1)
motor("PUT_LEFT_MOTOR_ID", drive)
motor("PUT_RIGHT_MOTOR_ID", drive)`,

    skidSteer: `# Differential Tank Steering
drive = forward() - back()
steer = turret()
left = clamp(drive + steer, -1, 1)
right = clamp(drive - steer, -1, 1)
motor("PUT_LEFT_MOTOR_ID", left)
motor("PUT_RIGHT_MOTOR_ID", right)`,

    radarTurret: `# Radar Target Tracking & Auto-Aim
bearing = sensor("PUT_RADAR_ID#bearing")
distance = sensor("PUT_RADAR_ID#range")

# PID calculates angle adjustment
aim = pid("turret_aim", 0, bearing, 0.05, 0.001, 0.02)
servo("PUT_TURRET_BEARING_ID", aim * 90)

# Fire cannon when aligned and in range
if abs(bearing) < 6 and distance < 18:
    weapon("PUT_CANNON_ID", 1)`,

    batteryEco: `# Battery Limiter / Eco Mode
charge = sensor("PUT_BATTERY_ID")
power = forward() - back()

# Throttle down when battery is under 25%
if charge < 25:
    power = power * 0.45

motor("PUT_MOTOR_ID", clamp(power, -1, 1))`,

    burstFire: `# 5-Tick Burst Sequencer
counter = recall("burst_cnt", 0)
if fire():
    counter = counter + 1
    if counter < 6:
        weapon("PUT_GUN_ID", 1)
    elif counter > 18:
        counter = 0
else:
    counter = 0
remember("burst_cnt", counter)`,
  };

  return `
    <div class="docs-section">
      <h4>COMMON RECIPES &amp; EXAMPLES</h4>
      <p>Copy any recipe directly into the Python editor. Remember to replace placeholder IDs with your actual motor, sensor, or weapon IDs from the COMPONENT inspector.</p>
    </div>

    <div class="docs-section">
      <h4>1. DUAL-MOTOR DRIVE</h4>
      <p>Basic two-wheel forward and reverse movement using W and S.</p>
      <pre class="docs-code">${snippets.tankDrive}</pre>
      <button class="docs-copy-btn" data-snippet="${escapeSnippet(snippets.tankDrive)}">COPY RECIPE</button>
    </div>

    <div class="docs-section">
      <h4>2. DIFFERENTIAL SKID STEERING</h4>
      <p>Combines drive (W/S) and steering (Q/E) to rotate tanks and carts in place.</p>
      <pre class="docs-code">${snippets.skidSteer}</pre>
      <button class="docs-copy-btn" data-snippet="${escapeSnippet(snippets.skidSteer)}">COPY RECIPE</button>
    </div>

    <div class="docs-section">
      <h4>3. RADAR TARGET TRACKING TURRET</h4>
      <p>Uses radar bearing with a PID loop to track opponents and fires when locked on.</p>
      <pre class="docs-code">${snippets.radarTurret}</pre>
      <button class="docs-copy-btn" data-snippet="${escapeSnippet(snippets.radarTurret)}">COPY RECIPE</button>
    </div>

    <div class="docs-section">
      <h4>4. BATTERY SAVER / ECO THROTTLE</h4>
      <p>Monitors battery state and halves motor draw during low battery conditions.</p>
      <pre class="docs-code">${snippets.batteryEco}</pre>
      <button class="docs-copy-btn" data-snippet="${escapeSnippet(snippets.batteryEco)}">COPY RECIPE</button>
    </div>

    <div class="docs-section">
      <h4>5. PULSED BURST FIRE</h4>
      <p>Uses <code>remember()</code> and <code>recall()</code> to pace weapon shots and prevent power spikes.</p>
      <pre class="docs-code">${snippets.burstFire}</pre>
      <button class="docs-copy-btn" data-snippet="${escapeSnippet(snippets.burstFire)}">COPY RECIPE</button>
    </div>
  `;
}

function escapeSnippet(text: string): string {
  return text.replace(/"/g, "&quot;");
}
