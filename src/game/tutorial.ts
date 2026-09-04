// SCRAP & STEEL: game/tutorial.ts
// Interactive tutorial: the player performs each step for real. Each step has
// a check() that inspects the actual build/sim state; the panel advances only
// when the action happened. No walls of text.

import type { Blueprint } from "./blueprint";
import { computeAdjacency, wiredToPower, robotStats } from "./blueprint";
import { part } from "./parts";

export interface TutorialCheckArgs {
  bp: Blueprint;
  mode: "build" | "test";
  battleKind: null | "bot" | "online";
  simTick: number;
  playerMoved: boolean; // root moved > 1 m from spawn during this test
  testUsed: boolean; // test mode entered at least once since step 7 armed
}

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** optional: show a tool or tab hint in the panel */
  hint?: string;
  check: (a: TutorialCheckArgs) => boolean;
  optional?: boolean;
}

export function wheelHasMotor(bp: Blueprint, wheelId: string): boolean {
  // wheel must touch a motor through adjacency (one edge)
  for (const a of computeAdjacency(bp)) {
    if (a.a === wheelId) {
      if (part(bp.parts.find((p) => p.id === a.b)?.def ?? "").motor) return true;
    }
    if (a.b === wheelId) {
      if (part(bp.parts.find((p) => p.id === a.a)?.def ?? "").motor) return true;
    }
  }
  return false;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "frame",
    title: "PLACE A FRAME",
    body: "Open STRUCTURE in the left panel. Click Aluminium Frame, then click the grid to place it. This is your chassis.",
    hint: "STRUCTURE tab",
    check: ({ bp }) => bp.parts.some((p) => part(p.def).cat === "structure"),
  },
  {
    id: "wheels",
    title: "ADD TWO WHEELS",
    body: "Open MOTION. Place two wheels in a row under the frame. Click the part, then click the grid.",
    hint: "MOTION tab",
    check: ({ bp }) => bp.parts.filter((p) => part(p.def).wheel).length >= 2,
  },
  {
    id: "motors",
    title: "ADD MOTORS",
    body: "Wheels need a motor touching them to spin. Place one motor against each wheel, edge to edge.",
    hint: "MOTION tab: Compact Motor",
    check: ({ bp }) => {
      const wheels = bp.parts.filter((p) => part(p.def).wheel);
      return wheels.length > 0 && wheels.every((w) => wheelHasMotor(bp, w.id));
    },
  },
  {
    id: "power",
    title: "ADD BATTERY AND CONTROLLER",
    body: "ELECTRICAL has batteries. CONTROL has the microcontroller. Bolt both onto the chassis. No controller, no logic.",
    hint: "ELECTRICAL + CONTROL tabs",
    check: ({ bp }) =>
      bp.parts.some((p) => part(p.def).source) && bp.parts.some((p) => part(p.def).cpu),
  },
  {
    id: "wire",
    title: "WIRE IT",
    body: "Press 3 or click WIRE. Click a battery port (small circle), then a motor port. Wire battery to each motor and to the controller. No wire, no power.",
    hint: "tool: WIRE",
    check: ({ bp }) => {
      const powered = wiredToPower(bp);
      const motors = bp.parts.filter((p) => part(p.def).motor);
      const cpus = bp.parts.filter((p) => (part(p.def).cpu ?? 0) > 0);
      if (!motors.length || !cpus.length) return false;
      return motors.every((m) => powered.has(m.id)) && cpus.every((c) => powered.has(c.id));
    },
  },
  {
    id: "logic",
    title: "PROGRAM THE DRIVE",
    body: "Bottom panel, LOGIC CIRCUIT. IN adds INPUT FORWARD. Add INPUT REVERSE too. MATH adds SUBTRACT. OUT adds MOTOR POWER, then set its Part dropdown to a motor. Chain them: forward minus reverse into motor power.",
    hint: "LOGIC CIRCUIT panel",
    check: ({ bp }) =>
      bp.logic.some((n) => n.type === "key_forward") &&
      bp.logic.some((n) => n.type === "key_back") &&
      bp.logic.some((n) => n.type === "motor_power" && n.params.part),
  },
  {
    id: "test",
    title: "TEST IT",
    body: "Press T or click TEST. Physics take over from your snapshot. The build clock does not matter here.",
    hint: "T key",
    check: ({ mode }) => mode === "test",
  },
  {
    id: "drive",
    title: "DRIVE IT",
    body: "Hold W. The robot drives right, because you wired it and programmed it. Green arrows on the wheels point where forward takes you.",
    hint: "hold W",
    check: ({ simTick, playerMoved }) => simTick > 60 && playerMoved,
  },
  {
    id: "restore",
    title: "END TEST, KEEP THE BUILD",
    body: "Press T again. The blueprint restores from the snapshot you took at TEST. Break anything in test mode; none of it follows you home. Nothing you break in test mode survives.",
    hint: "T key",
    check: ({ mode, testUsed }) => testUsed && mode === "build",
  },
  {
    id: "weapon",
    title: "BUILD A WEAPON",
    body: "WEAPONS tab: place a Breech on the chassis, an Ammunition Box touching it, and a Barrel on the breech. Wire all three to the battery. Add a WEAPON TRIGGER node bound to the breech.",
    hint: "WEAPONS tab",
    optional: true,
    check: ({ bp }) => {
      const breech = bp.parts.find((p) => part(p.def).weapon?.kind === "cannon" && !part(p.def).barrel);
      const ammo = bp.parts.some((p) => part(p.def).weapon?.ammoCap);
      const trig = bp.logic.some((n) => n.type === "weapon_fire" && n.params.part);
      return !!(breech && ammo && trig);
    },
  },
  {
    id: "battle",
    title: "FIGHT",
    body: "Menu, QUICK BATTLE vs BOT. Your checklist must pass. Then hold W and SPACE and see how your engineering holds up.",
    hint: "QUICK BATTLE",
    check: ({ battleKind }) => battleKind !== null,
  },
];

export interface TutorialState {
  active: boolean;
  step: number;
  done: boolean;
  dismissed: boolean;
  testUsed: boolean;
  playerMoved: boolean;
  spawnX: number | null;
  spawnZ: number | null;
}

export function loadTutorialState(): TutorialState {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("scrap_tutorial_done") === "1";
  } catch {
    // ignore
  }
  return { active: !dismissed, step: 0, done: false, dismissed, testUsed: false, playerMoved: false, spawnX: null, spawnZ: null };
}

export function persistDismissed() {
  try {
    localStorage.setItem("scrap_tutorial_done", "1");
  } catch {
    // ignore
  }
}

export function checkStep(step: TutorialStep, a: TutorialCheckArgs): boolean {
  try {
    return step.check(a);
  } catch {
    return false;
  }
}

export function tutorialSummary(bp: Blueprint): string {
  const st = robotStats(bp);
  return `${st.parts} parts, ${Math.round(st.mass)} kg, ${bp.wires.length} wires, ${bp.logic.length} nodes`;
}
