// SCRAP AND STEEL — content/parts.ts
// Data-driven part definitions. All balance numbers live here (tune via telemetry later).
// Grid unit = 0.5 m. Sizes are in grid cells.

export type PartCategory = "frame" | "armor" | "power" | "control" | "drive" | "weapon" | "cooling";

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  desc: string;
  cost: number; // Scrap Points
  mass: number; // kg
  size: [number, number, number]; // grid cells (0.5 m each); 0.4 thickness allowed for plates
  hp: number;
  shape: "box" | "wheel" | "wedge" | "spinner_drum" | "spinner_bar" | "saw";
  // power
  source?: { energy: number; peakW: number; heatCoef?: number }; // energy in kJ
  controller?: { capacityW: number };
  motor?: { torque: number; maxRpm: number; peakW: number; regulated: boolean };
  weapon?: {
    kind: "spinner" | "saw" | "lifter";
    peakW: number;
    spinupRpm: number;
    damageMult: number;
    reach: number;
  };
  lifter?: { impulse: number; recharge: number; peakW: number };
  cooling?: { rate: number; drawW: number };
  requiresController?: boolean; // motors run at 60% without a controller in the power path
}

const DEFS: PartDef[] = [
  // ---- Frame ----
  {
    id: "frame_tube", name: "Steel Frame Block", category: "frame",
    desc: "Cheap, strong, heavy general frame member.",
    cost: 10, mass: 6, size: [1, 1, 1], hp: 140, shape: "box",
  },
  {
    id: "frame_beam", name: "Steel Beam", category: "frame",
    desc: "Long frame member for chassis rails.",
    cost: 24, mass: 15, size: [3, 1, 1], hp: 300, shape: "box",
  },
  {
    id: "frame_bulkhead", name: "Bulkhead Plate", category: "frame",
    desc: "Strong internal wall and mounting plane.",
    cost: 30, mass: 16, size: [1, 3, 3], hp: 340, shape: "box",
  },
  {
    id: "frame_skid", name: "Skid Rail", category: "frame",
    desc: "Sacrificial underside rail for floor impacts.",
    cost: 8, mass: 3, size: [2, 1, 1], hp: 90, shape: "box",
  },
  // ---- Armor ----
  {
    id: "armor_steel", name: "Mild-Steel Plate", category: "armor",
    desc: "Cheap armor; heavy.",
    cost: 20, mass: 9, size: [1, 1, 0.25], hp: 280, shape: "box",
  },
  {
    id: "armor_hardened", name: "Hardened Steel Plate", category: "armor",
    desc: "Excellent wear/impact resistance; high cost and mass.",
    cost: 45, mass: 11, size: [1, 1, 0.25], hp: 460, shape: "box",
  },
  {
    id: "armor_alum", name: "Aluminum Plate", category: "armor",
    desc: "Low mass; dents and tears sooner.",
    cost: 12, mass: 4, size: [1, 1, 0.25], hp: 150, shape: "box",
  },
  {
    id: "armor_wedge", name: "Sloped Wedge Plate", category: "armor",
    desc: "Deflects contact and doubles as ground geometry.",
    cost: 22, mass: 6, size: [2, 1, 2], hp: 220, shape: "wedge",
  },
  // ---- Power ----
  {
    id: "battery_compact", name: "Compact Battery Pack", category: "power",
    desc: "Low mass/capacity; ideal for small robots.",
    cost: 40, mass: 5, size: [1, 1, 1], hp: 90, shape: "box",
    source: { energy: 420, peakW: 3200 },
  },
  {
    id: "battery_highcap", name: "High-Capacity Battery", category: "power",
    desc: "Long endurance; heavy.",
    cost: 90, mass: 13, size: [2, 1, 1], hp: 110, shape: "box",
    source: { energy: 1300, peakW: 3200 },
  },
  {
    id: "battery_hidisc", name: "High-Discharge Battery", category: "power",
    desc: "Strong burst output; heats quickly under sustained load.",
    cost: 80, mass: 8, size: [1, 1, 1], hp: 85, shape: "box",
    source: { energy: 520, peakW: 9500, heatCoef: 1.6 },
  },
  {
    id: "supercap", name: "Supercapacitor Bank", category: "power",
    desc: "Excellent short bursts; poor total energy.",
    cost: 60, mass: 6, size: [1, 1, 1], hp: 95, shape: "box",
    source: { energy: 160, peakW: 16000 },
  },
  {
    id: "motor_controller", name: "Motor Controller", category: "power",
    desc: "Delivers full regulated power to motors/weapons on its path. Unregulated loads run at 60%.",
    cost: 40, mass: 2, size: [1, 1, 0.5], hp: 80, shape: "box",
    controller: { capacityW: 6000 },
  },
  // ---- Control ----
  {
    id: "control_core", name: "Control Core", category: "control",
    desc: "The robot's brain. Binds inputs to devices. Required to control anything.",
    cost: 60, mass: 3, size: [1, 1, 1], hp: 80, shape: "box",
  },
  // ---- Drive ----
  {
    id: "motor_compact", name: "Compact DC Motor", category: "drive",
    desc: "Light, low torque and power draw.",
    cost: 50, mass: 4, size: [1, 1, 1], hp: 75, shape: "box",
    motor: { torque: 14, maxRpm: 240, peakW: 1600, regulated: false },
  },
  {
    id: "motor_torque", name: "Torque Motor", category: "drive",
    desc: "Slow, high torque; good for heavy drive.",
    cost: 90, mass: 9, size: [1, 1, 1], hp: 90, shape: "box",
    motor: { torque: 42, maxRpm: 140, peakW: 2600, regulated: false },
  },
  {
    id: "motor_speed", name: "High-Speed Brushless Motor", category: "drive",
    desc: "Fast and power-dense; needs a controller and cooling.",
    cost: 85, mass: 5, size: [1, 1, 1], hp: 70, shape: "box",
    motor: { torque: 10, maxRpm: 420, peakW: 3200, regulated: true },
  },
  {
    id: "wheel_rubber", name: "Rubber Wheel", category: "drive",
    desc: "High grip, simple, general purpose. Must touch a motor to be driven.",
    cost: 15, mass: 2, size: [1, 1, 1], hp: 140, shape: "wheel",
  },
  {
    id: "wheel_hard", name: "Hard Wheel", category: "drive",
    desc: "Lower grip, low rolling loss, resilient.",
    cost: 12, mass: 1.5, size: [1, 1, 1], hp: 190, shape: "wheel",
  },
  {
    id: "wheel_pneumatic", name: "Pneumatic Tire", category: "drive",
    desc: "Shock absorption and traction; vulnerable to damage.",
    cost: 30, mass: 3, size: [1, 1, 1], hp: 110, shape: "wheel",
  },
  // ---- Weapons ----
  {
    id: "spinner_drum", name: "Drum Spinner", category: "weapon",
    desc: "Compact contact patch and strong bite. High spin-up draw.",
    cost: 120, mass: 10, size: [2, 1, 1], hp: 110, shape: "spinner_drum",
    weapon: { kind: "spinner", peakW: 4200, spinupRpm: 900, damageMult: 3.2, reach: 0.35 },
  },
  {
    id: "spinner_bar", name: "Horizontal Bar Spinner", category: "weapon",
    desc: "Large reach and recoil loads; dangerous to own frame.",
    cost: 140, mass: 12, size: [3, 1, 1], hp: 100, shape: "spinner_bar",
    weapon: { kind: "spinner", peakW: 5200, spinupRpm: 700, damageMult: 3.8, reach: 0.9 },
  },
  {
    id: "saw", name: "Circular Saw", category: "weapon",
    desc: "Sustained cutting damage; lower single-hit impulse.",
    cost: 100, mass: 6, size: [1, 1, 1], hp: 85, shape: "saw",
    weapon: { kind: "saw", peakW: 2400, spinupRpm: 1400, damageMult: 1.6, reach: 0.3 },
  },
  {
    id: "lifter", name: "Lifting Fork Actuator", category: "weapon",
    desc: "Low-profile leverage; burst lift with recharge time.",
    cost: 130, mass: 8, size: [2, 1, 1], hp: 95, shape: "box",
    lifter: { impulse: 5200, recharge: 2.5, peakW: 2000 },
  },
  // ---- Cooling ----
  {
    id: "heatsink", name: "Passive Heatsink", category: "cooling",
    desc: "Adds surface area; no power draw.",
    cost: 20, mass: 2, size: [1, 1, 0.5], hp: 60, shape: "box",
    cooling: { rate: 0.9, drawW: 0 },
  },
  {
    id: "fan", name: "Cooling Fan", category: "cooling",
    desc: "Forced airflow; vulnerable and power-consuming.",
    cost: 25, mass: 1, size: [1, 1, 0.5], hp: 40, shape: "box",
    cooling: { rate: 2.2, drawW: 120 },
  },
];

export const PART_DEFS: Record<string, PartDef> = Object.fromEntries(DEFS.map((d) => [d.id, d]));

export const PART_LIST = DEFS;

export const CATEGORIES: { id: PartCategory; name: string }[] = [
  { id: "frame", name: "Frame" },
  { id: "armor", name: "Armor" },
  { id: "power", name: "Power" },
  { id: "control", name: "Control" },
  { id: "drive", name: "Drive" },
  { id: "weapon", name: "Weapons" },
  { id: "cooling", name: "Cooling" },
];

// ---- Arena defs ----
export interface ArenaDef {
  id: string;
  name: string;
  desc: string;
  half: number; // half extent of square floor (m)
  wallH: number;
  ramps: boolean;
}

export const ARENAS: Record<string, ArenaDef> = {
  foundry: { id: "foundry", name: "Foundry", desc: "Baseline rectangular arena, flat floor, strong walls.", half: 9, wallH: 2, ramps: false },
  grid: { id: "grid", name: "Test Grid", desc: "Clean tournament-style arena for competitive matches.", half: 9, wallH: 2, ramps: false },
  pitworks: { id: "pitworks", name: "Pitworks", desc: "Ramps and raised edges; casual variant.", half: 10, wallH: 2, ramps: true },
};

// ---- Lobby presets ----
export const BUDGET_PRESETS = [
  { name: "Light", sp: 700 },
  { name: "Standard", sp: 1000 },
  { name: "Heavy", sp: 1400 },
];

export const WIRE_COST = 5;
export const WIRE_CAP_W = { light: 2600, medium: 6000, heavy: 12000 } as const;
export type WireGauge = keyof typeof WIRE_CAP_W;
