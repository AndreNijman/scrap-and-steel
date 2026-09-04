// SCRAP & STEEL — game/parts.ts
// The parts library. Every part: grid footprint (cells, 1 cell = 0.5 m), physical
// stats, electrical ports, pixel-art paint spec. Balance numbers live here only.

export type Category = "structure" | "armour" | "motion" | "electrical" | "control" | "sensors" | "weapons" | "utility" | "hydraulics";

export type PortKind = "power" | "data" | "fluid";

export interface Port {
  /** side of the footprint: 0=left 1=top 2=right 3=bottom */
  side: 0 | 1 | 2 | 3;
  /** position along that side, 0..1 */
  off: number;
  kind: PortKind;
  dir: "in" | "out" | "io";
}

export type Shape = "box" | "wheel" | "triL" | "triR" | "disc";

export interface PartDef {
  id: string;
  name: string;
  cat: Category;
  desc: string;
  w: number; // cells
  h: number;
  mass: number; // kg
  hp: number;
  cost: number; // $
  shape: Shape;
  armor?: number; // damage taken multiplier (lower = tougher)
  ports: Port[];
  // power generation / storage
  source?: { watts?: number; energyKJ?: number; fuelSec?: number; heat?: number };
  idleWatts?: number;
  // electrical management
  fuse?: { amps: number };
  capacitor?: { kJ: number };
  // actuation
  motor?: { torque: number; rpm: number; watts: number; heat: number };
  piston?: { force: number; speed: number; range: number; watts: number }; // prismatic, meters
  servo?: { torque: number; speed: number; watts: number }; // position-controlled revolute
  wheel?: { radius: number; grip: number; powered?: boolean };
  // weapons
  weapon?: {
    kind: "cannon" | "rotary" | "rail" | "arc" | "spinner" | "missile";
    dmg: number;
    rate?: number; // shots/sec for cannon/rotary
    watts: number;
    heat: number;
    ammoCap?: number;
    range?: number;
    muzzleSide?: 0 | 1 | 2 | 3; // where projectiles spawn
  };
  // computing
  cpu?: number; // capacity provided
  // sensors
  sensor?: { kind: string; range?: number };
  // thermal
  cooling?: { rate: number; watts?: number };
  flammable?: boolean;
  // structural special behaviours
  hinge?: boolean;
  turret?: boolean;
  slope?: boolean;
  reactive?: boolean;
  heatProof?: boolean;
  barrel?: boolean;
  ammo?: boolean;
  track?: { grip: number };
}

const P = (side: Port["side"], off: number, kind: PortKind, dir: Port["dir"] = "io"): Port => ({ side, off, kind, dir });

export const PARTS: PartDef[] = [
  // ================= STRUCTURE =================
  { id: "steel_block", name: "Steel Block", cat: "structure", desc: "Dense structural cube. Cheap and strong.", w: 1, h: 1, mass: 40, hp: 220, cost: 20, shape: "box", armor: 1.0, ports: [] },
  { id: "steel_beam_h", name: "Steel Beam", cat: "structure", desc: "Horizontal I-beam. Strong for its weight.", w: 3, h: 1, mass: 90, hp: 380, cost: 55, shape: "box", armor: 1.0, ports: [] },
  { id: "steel_beam_v", name: "Steel Column", cat: "structure", desc: "Vertical I-beam.", w: 1, h: 3, mass: 90, hp: 380, cost: 55, shape: "box", armor: 1.0, ports: [] },
  { id: "alu_frame", name: "Aluminium Frame", cat: "structure", desc: "Lightweight hollow frame. Weak but very light.", w: 2, h: 2, mass: 40, hp: 140, cost: 45, shape: "box", armor: 1.25, ports: [] },
  { id: "heavy_frame", name: "Heavy Frame", cat: "structure", desc: "Reinforced industrial chassis block.", w: 2, h: 2, mass: 200, hp: 620, cost: 110, shape: "box", armor: 0.9, ports: [] },
  { id: "reinforced_plate", name: "Reinforced Plate", cat: "structure", desc: "Thick structural plate with mounting holes.", w: 2, h: 1, mass: 60, hp: 300, cost: 40, shape: "box", armor: 1.0, ports: [] },
  { id: "corner_bracket", name: "Corner Bracket", cat: "structure", desc: "Right-angle reinforcement.", w: 1, h: 1, mass: 14, hp: 110, cost: 12, shape: "box", armor: 1.1, ports: [] },
  { id: "tri_brace", name: "Triangular Brace", cat: "structure", desc: "Triangle brace. Sloped on the left.", w: 1, h: 1, mass: 18, hp: 130, cost: 15, shape: "triL", armor: 1.05, ports: [] },
  { id: "tri_brace_r", name: "Triangular Brace R", cat: "structure", desc: "Triangle brace, mirrored.", w: 1, h: 1, mass: 18, hp: 130, cost: 15, shape: "triR", armor: 1.05, ports: [] },
  { id: "cross_brace", name: "Cross Brace", cat: "structure", desc: "X-braced panel. Very rigid.", w: 2, h: 2, mass: 70, hp: 260, cost: 50, shape: "box", armor: 1.0, ports: [] },
  { id: "mount_plate", name: "Mounting Plate", cat: "structure", desc: "Drilled plate for bolting hardware.", w: 2, h: 1, mass: 34, hp: 170, cost: 26, shape: "box", armor: 1.0, ports: [P(1, 0.5, "power", "io")] },
  { id: "hinge_block", name: "Hinge", cat: "structure", desc: "Free-swinging pivot. Attach a part to its right.", w: 1, h: 1, mass: 20, hp: 150, cost: 60, shape: "box", armor: 1.0, ports: [], hinge: true },
  { id: "shock_mount", name: "Shock Absorber", cat: "structure", desc: "Dampens impacts on attached parts.", w: 1, h: 1, mass: 16, hp: 120, cost: 40, shape: "box", armor: 1.0, ports: [] },
  { id: "ballast", name: "Ballast Weight", cat: "structure", desc: "Dense dead weight. Tune your centre of mass.", w: 1, h: 1, mass: 160, hp: 240, cost: 30, shape: "box", armor: 0.95, ports: [] },
  { id: "turret_bearing", name: "Turret Bearing", cat: "structure", desc: "Rotating mount. Parts bolted above spin freely. Drive it with a servo.", w: 1, h: 2, mass: 45, hp: 220, cost: 130, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "power", "io")], turret: true },
  { id: "scrap_chunk", name: "Scrap Chunk", cat: "structure", desc: "Junk with personality.", w: 1, h: 1, mass: 30, hp: 100, cost: 5, shape: "box", armor: 1.15, ports: [] },

  // ================= ARMOUR =================
  { id: "arm_light", name: "Light Steel Plate", cat: "armour", desc: "Thin mild-steel armour.", w: 1, h: 1, mass: 26, hp: 200, cost: 24, shape: "box", armor: 0.72, ports: [] },
  { id: "arm_heavy", name: "Heavy Steel Plate", cat: "armour", desc: "Thick rolled steel. Very heavy.", w: 1, h: 1, mass: 64, hp: 480, cost: 60, shape: "box", armor: 0.5, ports: [] },
  { id: "arm_hardened", name: "Hardened Steel Plate", cat: "armour", desc: "Heat-treated plate. Excellent protection.", w: 1, h: 1, mass: 58, hp: 620, cost: 110, shape: "box", armor: 0.38, ports: [] },
  { id: "arm_ceramic", name: "Ceramic Plate", cat: "armour", desc: "Shatters under repeated hits but blunts kinetics.", w: 1, h: 1, mass: 30, hp: 400, cost: 140, shape: "box", armor: 0.45, ports: [], flammable: false },
  { id: "arm_composite", name: "Composite Armour", cat: "armour", desc: "Layered fibres. Great protection per kg.", w: 1, h: 1, mass: 34, hp: 520, cost: 170, shape: "box", armor: 0.42, ports: [] },
  { id: "arm_reactive", name: "Reactive Armour", cat: "armour", desc: "Consumes itself to nullify one big hit, then degrades.", w: 1, h: 1, mass: 36, hp: 300, cost: 200, shape: "box", armor: 0.3, ports: [], reactive: true },
  { id: "arm_sloped", name: "Sloped Armour", cat: "armour", desc: "Deflects incoming rounds from the left.", w: 1, h: 1, mass: 30, hp: 340, cost: 70, shape: "triL", armor: 0.55, ports: [], slope: true },
  { id: "arm_sloped_r", name: "Sloped Armour R", cat: "armour", desc: "Deflects incoming rounds from the right.", w: 1, h: 1, mass: 30, hp: 340, cost: 70, shape: "triR", armor: 0.55, ports: [], slope: true },
  { id: "arm_heat", name: "Heat-Resistant Plate", cat: "armour", desc: "Ablative shield against energy and fire.", w: 1, h: 1, mass: 40, hp: 420, cost: 150, shape: "box", armor: 0.55, ports: [], heatProof: true },
  { id: "arm_spaced", name: "Spaced Armour", cat: "armour", desc: "Outer sacrificial shell over an air gap.", w: 1, h: 1, mass: 22, hp: 260, cost: 55, shape: "box", armor: 0.6, ports: [] },

  // ================= MOTION =================
  { id: "wheel_small", name: "Small Wheel", cat: "motion", desc: "Ø0.4 m. Light and quick to spin up.", w: 1, h: 1, mass: 12, hp: 90, cost: 30, shape: "wheel", ports: [], wheel: { radius: 0.2, grip: 1.1, powered: false } },
  { id: "wheel_medium", name: "Medium Wheel", cat: "motion", desc: "Ø0.5 m general-purpose wheel.", w: 1, h: 1, mass: 18, hp: 130, cost: 45, shape: "wheel", ports: [], wheel: { radius: 0.25, grip: 1.25, powered: false } },
  { id: "wheel_large", name: "Large Wheel", cat: "motion", desc: "Ø0.8 m. Climbs obstacles well.", w: 2, h: 2, mass: 40, hp: 200, cost: 85, shape: "wheel", ports: [], wheel: { radius: 0.4, grip: 1.3, powered: false } },
  { id: "wheel_racing", name: "Racing Wheel", cat: "motion", desc: "Low rolling resistance, high top speed.", w: 1, h: 1, mass: 14, hp: 80, cost: 90, shape: "wheel", ports: [], wheel: { radius: 0.26, grip: 1.0, powered: false } },
  { id: "wheel_offroad", name: "Off-Road Wheel", cat: "motion", desc: "Deep lugs. Grips loose terrain.", w: 2, h: 2, mass: 44, hp: 240, cost: 120, shape: "wheel", ports: [], wheel: { radius: 0.42, grip: 1.6, powered: false } },
  { id: "wheel_armored", name: "Armoured Wheel", cat: "motion", desc: "Protected hub. Survives incoming fire.", w: 2, h: 2, mass: 60, hp: 420, cost: 190, shape: "wheel", ports: [], wheel: { radius: 0.4, grip: 1.2, powered: false } },
  { id: "wheel_omni", name: "Omni Wheel", cat: "motion", desc: "Rollers around the rim. Slips sideways less.", w: 1, h: 1, mass: 16, hp: 90, cost: 110, shape: "wheel", ports: [], wheel: { radius: 0.25, grip: 0.9, powered: false } },
  { id: "wheel_caster", name: "Caster", cat: "motion", desc: "Unpowered support wheel.", w: 1, h: 1, mass: 8, hp: 70, cost: 18, shape: "wheel", ports: [], wheel: { radius: 0.16, grip: 0.8, powered: false } },
  { id: "track_unit", name: "Track Drive Unit", cat: "motion", desc: "Motorised track module with its own contact patch.", w: 2, h: 2, mass: 80, hp: 320, cost: 220, shape: "box", armor: 0.9, ports: [P(0, 0.5, "power", "in")], track: { grip: 1.7 } },
  { id: "motor_small", name: "Compact Motor", cat: "motion", desc: "120 W toy of a motor. Light duty.", w: 1, h: 1, mass: 14, hp: 90, cost: 70, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "power", "io")], motor: { torque: 55, rpm: 260, watts: 320, heat: 0.5 } },
  { id: "motor_torque", name: "High-Torque Motor", cat: "motion", desc: "Grinds hard, spins slow.", w: 2, h: 1, mass: 44, hp: 150, cost: 210, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "power", "io")], motor: { torque: 320, rpm: 110, watts: 900, heat: 0.9 } },
  { id: "motor_speed", name: "High-Speed Motor", cat: "motion", desc: "Screams. Great with big wheels.", w: 2, h: 1, mass: 30, hp: 110, cost: 240, shape: "box", armor: 1.05, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "power", "io")], motor: { torque: 90, rpm: 520, watts: 1100, heat: 1.0 } },
  { id: "motor_industrial", name: "Industrial Motor", cat: "motion", desc: "Traction at any price.", w: 2, h: 2, mass: 90, hp: 240, cost: 520, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "power", "io")], motor: { torque: 700, rpm: 170, watts: 2400, heat: 1.1 } },
  { id: "servo", name: "Servo", cat: "motion", desc: "Position-controlled joint. Aim turrets, arms.", w: 1, h: 1, mass: 12, hp: 90, cost: 140, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], servo: { torque: 90, speed: 3.2, watts: 120 } },
  { id: "linear_actuator", name: "Linear Actuator", cat: "motion", desc: "Electric ram. Pushes 0.5 m.", w: 2, h: 1, mass: 26, hp: 130, cost: 190, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], piston: { force: 9000, speed: 0.8, range: 0.5, watts: 350 } },
  { id: "spinner_disc", name: "Spinner Disc", cat: "motion", desc: "Weapon-grade flywheel disc. Shreds on contact.", w: 2, h: 2, mass: 70, hp: 260, cost: 260, shape: "disc", ports: [], weapon: { kind: "spinner", dmg: 34, watts: 1400, heat: 1.0 } },

  // ================= ELECTRICAL =================
  { id: "battery_small", name: "Small Battery", cat: "electrical", desc: "2 MJ cell pack.", w: 1, h: 1, mass: 22, hp: 110, cost: 90, shape: "box", armor: 1.0, flammable: true, ports: [P(2, 0.5, "power", "out"), P(0, 0.5, "power", "io")], source: { energyKJ: 2000 } },
  { id: "battery_pack", name: "Battery Pack", cat: "electrical", desc: "6 MJ of six chunky cells.", w: 2, h: 1, mass: 56, hp: 190, cost: 210, shape: "box", armor: 1.0, flammable: true, ports: [P(2, 0.5, "power", "out"), P(0, 0.5, "power", "io")], source: { energyKJ: 6000 } },
  { id: "battery_hd", name: "High-Density Battery", cat: "electrical", desc: "14 MJ. Expensive, volatile.", w: 1, h: 2, mass: 64, hp: 150, cost: 420, shape: "box", armor: 1.1, flammable: true, ports: [P(2, 0.5, "power", "out"), P(0, 0.5, "power", "io")], source: { energyKJ: 14000 } },
  { id: "capacitor", name: "Capacitor Bank", cat: "electrical", desc: "150 kJ burst buffer. Railguns love it.", w: 1, h: 1, mass: 20, hp: 100, cost: 180, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")], capacitor: { kJ: 150 } },
  { id: "generator", name: "Generator", cat: "electrical", desc: "3200 W fuel generator. Drinks fuel, runs hot.", w: 2, h: 2, mass: 120, hp: 220, cost: 600, shape: "box", armor: 1.0, ports: [P(2, 0.5, "power", "out")], source: { watts: 3200, fuelSec: 240, heat: 1.2 } },
  { id: "generator_big", name: "Industrial Generator", cat: "electrical", desc: "6500 W. Powers serious machinery.", w: 2, h: 2, mass: 210, hp: 260, cost: 1250, shape: "box", armor: 1.0, ports: [P(2, 0.5, "power", "out")], source: { watts: 6500, fuelSec: 300, heat: 1.4 } },
  { id: "solar_panel", name: "Solar Panel", cat: "electrical", desc: "Trickle power. 60 W in the sun.", w: 2, h: 1, mass: 18, hp: 70, cost: 130, shape: "box", armor: 1.2, ports: [P(2, 0.5, "power", "out")], source: { watts: 60 } },
  { id: "fuse", name: "Fuse", cat: "electrical", desc: "Sacrificial 30 A link. Trips before wires burn.", w: 1, h: 1, mass: 4, hp: 60, cost: 25, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")], fuse: { amps: 30 } },
  { id: "breaker", name: "Circuit Breaker", cat: "electrical", desc: "45 A breaker. Resets after cooling down.", w: 1, h: 1, mass: 8, hp: 90, cost: 70, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")], fuse: { amps: 45 } },
  { id: "switch", name: "Power Switch", cat: "electrical", desc: "Manual disconnect. Toggle from diagnostics.", w: 1, h: 1, mass: 5, hp: 70, cost: 30, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")], fuse: { amps: 60 } },
  { id: "relay", name: "Relay", cat: "electrical", desc: "Signal-switched 40 A contactor.", w: 1, h: 1, mass: 7, hp: 80, cost: 80, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io"), P(1, 0.5, "data", "in")], fuse: { amps: 40 } },
  { id: "regulator", name: "Voltage Regulator", cat: "electrical", desc: "Stiffens the bus. Reduces voltage sag.", w: 1, h: 1, mass: 10, hp: 90, cost: 120, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")] },
  { id: "dist_board", name: "Distribution Board", cat: "electrical", desc: "6-way junction. The heart of a tidy loom.", w: 1, h: 2, mass: 12, hp: 120, cost: 90, shape: "box", armor: 1.0, ports: [P(0, 0.25, "power", "io"), P(0, 0.75, "power", "io"), P(2, 0.25, "power", "io"), P(2, 0.75, "power", "io"), P(1, 0.5, "power", "io")] },
  { id: "bus_bar", name: "Power Bus Bar", cat: "electrical", desc: "Copper rail. 80 A trunk.", w: 2, h: 1, mass: 16, hp: 150, cost: 70, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io"), P(1, 0.3, "power", "io"), P(1, 0.7, "power", "io")] },
  { id: "light", name: "Work Light", cat: "electrical", desc: "Mostly decorative. 10 W.", w: 1, h: 1, mass: 3, hp: 50, cost: 15, shape: "box", armor: 1.3, ports: [P(0, 0.5, "power", "in")], idleWatts: 10 },

  // ================= CONTROL =================
  { id: "micro_controller", name: "Microcontroller", cat: "control", desc: "8 logic nodes. Enough for a humble cart.", w: 1, h: 1, mass: 6, hp: 100, cost: 150, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in")], cpu: 8, idleWatts: 15 },
  { id: "logic_processor", name: "Logic Processor", cat: "control", desc: "24 logic nodes.", w: 1, h: 1, mass: 12, hp: 120, cost: 380, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in")], cpu: 24, idleWatts: 30 },
  { id: "advanced_cpu", name: "Advanced CPU", cat: "control", desc: "64 logic nodes. Overkill is a lifestyle.", w: 2, h: 1, mass: 26, hp: 160, cost: 900, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in")], cpu: 64, idleWatts: 70 },
  { id: "sensor_hub", name: "Sensor Hub", cat: "control", desc: "Aggregates sensor wiring. +8 CPU.", w: 1, h: 1, mass: 8, hp: 100, cost: 200, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "io"), P(1, 0.5, "data", "io")], cpu: 8, idleWatts: 12 },
  { id: "radio", name: "Radio Module", cat: "control", desc: "Remote link. +4 CPU.", w: 1, h: 1, mass: 6, hp: 80, cost: 160, shape: "box", armor: 1.1, ports: [P(0, 0.5, "power", "in")], cpu: 4, idleWatts: 18 },

  // ================= SENSORS =================
  { id: "sen_distance", name: "Distance Sensor", cat: "sensors", desc: "Ultrasound rangefinder, 8 m cone.", w: 1, h: 1, mass: 4, hp: 60, cost: 90, shape: "box", armor: 1.2, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "distance", range: 8 }, idleWatts: 4 },
  { id: "sen_laser", name: "Laser Rangefinder", cat: "sensors", desc: "Precise 20 m ray.", w: 1, h: 1, mass: 6, hp: 60, cost: 190, shape: "box", armor: 1.2, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "distance", range: 20 }, idleWatts: 6 },
  { id: "sen_gyro", name: "Gyroscope", cat: "sensors", desc: "Chassis tilt angle, degrees.", w: 1, h: 1, mass: 5, hp: 70, cost: 120, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "gyro" }, idleWatts: 4 },
  { id: "sen_battery", name: "Battery Sensor", cat: "sensors", desc: "Charge percentage of the power net.", w: 1, h: 1, mass: 3, hp: 60, cost: 60, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "battery" }, idleWatts: 2 },
  { id: "sen_voltage", name: "Voltage Sensor", cat: "sensors", desc: "Bus voltage, volts.", w: 1, h: 1, mass: 3, hp: 60, cost: 60, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "voltage" }, idleWatts: 2 },
  { id: "sen_current", name: "Current Sensor", cat: "sensors", desc: "Bus current, amps.", w: 1, h: 1, mass: 3, hp: 60, cost: 60, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "current" }, idleWatts: 2 },
  { id: "sen_temp", name: "Temperature Sensor", cat: "sensors", desc: "Hottest component on the robot, °C.", w: 1, h: 1, mass: 3, hp: 60, cost: 70, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "temp" }, idleWatts: 2 },
  { id: "sen_encoder", name: "Wheel Encoder", cat: "sensors", desc: "Drive speed, km/h.", w: 1, h: 1, mass: 3, hp: 60, cost: 80, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "speed" }, idleWatts: 2 },
  { id: "sen_gyro_rate", name: "Accelerometer", cat: "sensors", desc: "Impact g-force.", w: 1, h: 1, mass: 3, hp: 60, cost: 90, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "impact" }, idleWatts: 2 },
  { id: "sen_radar", name: "Radar", cat: "sensors", desc: "Enemy bearing and range. Auto-turret bread and butter.", w: 2, h: 1, mass: 14, hp: 90, cost: 420, shape: "box", armor: 1.15, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "radar", range: 40 }, idleWatts: 25 },
  { id: "sen_camera", name: "Camera", cat: "sensors", desc: "Enemy visual detection cone.", w: 1, h: 1, mass: 5, hp: 60, cost: 240, shape: "box", armor: 1.2, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "radar", range: 25 }, idleWatts: 8 },
  { id: "sen_proximity", name: "Proximity Sensor", cat: "sensors", desc: "1 if anything is within 3 m.", w: 1, h: 1, mass: 3, hp: 60, cost: 70, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "data", "out")], sensor: { kind: "proximity", range: 3 }, idleWatts: 2 },

  // ================= WEAPONS =================
  { id: "gun_breech", name: "Breech", cat: "weapons", desc: "Loading and firing mechanism. Wire ammo and trigger.", w: 1, h: 1, mass: 24, hp: 160, cost: 180, shape: "box", armor: 0.95, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in"), P(2, 0.5, "power", "io")], weapon: { kind: "cannon", dmg: 26, watts: 200, heat: 0.8, muzzleSide: 2 } },
  { id: "gun_barrel_s", name: "Cannon Barrel", cat: "weapons", desc: "Short barrel. Attaches to a breech's right.", w: 2, h: 1, mass: 30, hp: 190, cost: 140, shape: "box", armor: 0.95, ports: [P(0, 0.5, "power", "io")], weapon: { kind: "cannon", dmg: 0, watts: 0, heat: 0, muzzleSide: 2 }, barrel: true },
  { id: "gun_barrel_l", name: "Long Cannon Barrel", cat: "weapons", desc: "Velocity and reach.", w: 3, h: 1, mass: 48, hp: 230, cost: 260, shape: "box", armor: 0.95, ports: [P(0, 0.5, "power", "io")], weapon: { kind: "cannon", dmg: 0, watts: 0, heat: 0, muzzleSide: 2 }, barrel: true },
  { id: "ammo_box", name: "Ammunition Box", cat: "weapons", desc: "20 shells. Explodes when destroyed!", w: 2, h: 1, mass: 40, hp: 150, cost: 120, shape: "box", armor: 1.0, flammable: true, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io")], weapon: { kind: "cannon", dmg: 0, watts: 0, heat: 0, ammoCap: 20 }, ammo: true },
  { id: "rotary_cannon", name: "Rotary Cannon", cat: "weapons", desc: "Motor-driven gatling. Spins up, eats ammo.", w: 3, h: 2, mass: 90, hp: 260, cost: 850, shape: "box", armor: 0.95, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], weapon: { kind: "rotary", dmg: 9, rate: 8, watts: 1600, heat: 1.6, ammoCap: 120, muzzleSide: 2 } },
  { id: "railgun", name: "Railgun", cat: "weapons", desc: "Electromagnetic lance. Devastating. Starves entire robots.", w: 3, h: 2, mass: 160, hp: 300, cost: 1900, shape: "box", armor: 0.95, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], weapon: { kind: "rail", dmg: 95, rate: 0.25, watts: 9000, heat: 2.4, muzzleSide: 2 } },
  { id: "arc_emitter", name: "Arc Emitter", cat: "weapons", desc: "Short-range lightning. Sets wiring on fire.", w: 1, h: 2, mass: 30, hp: 150, cost: 700, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], weapon: { kind: "arc", dmg: 7, rate: 5, watts: 2200, heat: 1.8, range: 4.5, muzzleSide: 2 } },
  { id: "missile_pod", name: "Missile Pod", cat: "weapons", desc: "4 rockets, then it is a paperweight.", w: 2, h: 2, mass: 55, hp: 140, cost: 950, shape: "box", armor: 1.1, flammable: true, ports: [P(0, 0.5, "power", "in"), P(1, 0.5, "data", "in")], weapon: { kind: "missile", dmg: 45, rate: 0.5, watts: 300, heat: 0.6, ammoCap: 4, muzzleSide: 2 } },
  { id: "spinner_disc_w", name: "Weapon Spinner", cat: "weapons", desc: "Heavy kinetic disc. Mount on a motor, drive it hard.", w: 2, h: 2, mass: 90, hp: 320, cost: 420, shape: "disc", ports: [], weapon: { kind: "spinner", dmg: 52, watts: 0, heat: 0.3 } },

  // ================= UTILITY =================
  { id: "conduit", name: "Cable Conduit", cat: "utility", desc: "Armoured wire channel. Protects wires routed through it.", w: 2, h: 1, mass: 14, hp: 190, cost: 45, shape: "box", armor: 0.9, ports: [] },
  { id: "junction_box", name: "Junction Box", cat: "utility", desc: "Sealed 4-way splice.", w: 1, h: 1, mass: 6, hp: 110, cost: 30, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "io"), P(2, 0.5, "power", "io"), P(1, 0.5, "power", "io"), P(3, 0.5, "power", "io")] },
  { id: "heatsink", name: "Heat Sink", cat: "utility", desc: "Passive cooling fins.", w: 1, h: 1, mass: 10, hp: 110, cost: 55, shape: "box", armor: 1.0, ports: [], cooling: { rate: 0.9 } },
  { id: "fan", name: "Cooling Fan", cat: "utility", desc: "Forced airflow. 60 W.", w: 1, h: 1, mass: 6, hp: 70, cost: 80, shape: "box", armor: 1.15, ports: [P(0, 0.5, "power", "in")], cooling: { rate: 2.4, watts: 60 } },
  { id: "radiator", name: "Radiator", cat: "utility", desc: "Big liquid-cooled stack.", w: 2, h: 2, mass: 34, hp: 170, cost: 240, shape: "box", armor: 1.05, ports: [P(0, 0.5, "power", "in")], cooling: { rate: 5.5, watts: 140 } },
  { id: "coolant_tank", name: "Coolant Tank", cat: "utility", desc: "Extends cooling endurance.", w: 1, h: 1, mass: 22, hp: 130, cost: 110, shape: "box", armor: 1.0, ports: [], cooling: { rate: 1.2 } },

  // ================= HYDRAULICS =================
  { id: "hyd_pump", name: "Hydraulic Pump", cat: "hydraulics", desc: "Converts power to pressure. 500 W.", w: 2, h: 1, mass: 40, hp: 160, cost: 380, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "fluid", "out")], idleWatts: 60 },
  { id: "hyd_tank", name: "Hydraulic Tank", cat: "hydraulics", desc: "Fluid reservoir.", w: 1, h: 1, mass: 26, hp: 140, cost: 130, shape: "box", armor: 1.0, ports: [P(2, 0.5, "fluid", "io")] },
  { id: "hyd_piston", name: "Hydraulic Piston", cat: "hydraulics", desc: "Massive force, moderate speed. 0.6 m stroke.", w: 2, h: 1, mass: 48, hp: 200, cost: 520, shape: "box", armor: 1.0, ports: [P(0, 0.5, "fluid", "in"), P(1, 0.5, "data", "in")], piston: { force: 26000, speed: 0.55, range: 0.6, watts: 0 } },
  { id: "pneumatic_piston", name: "Pneumatic Piston", cat: "hydraulics", desc: "Fast burst ram. 0.4 m stroke.", w: 2, h: 1, mass: 26, hp: 130, cost: 340, shape: "box", armor: 1.0, ports: [P(0, 0.5, "fluid", "in"), P(1, 0.5, "data", "in")], piston: { force: 11000, speed: 2.2, range: 0.4, watts: 0 } },
  { id: "compressor", name: "Air Compressor", cat: "hydraulics", desc: "Charges pneumatic systems. 400 W.", w: 2, h: 1, mass: 34, hp: 140, cost: 300, shape: "box", armor: 1.0, ports: [P(0, 0.5, "power", "in"), P(2, 0.5, "fluid", "out")], idleWatts: 50 },
  { id: "air_tank", name: "Air Tank", cat: "hydraulics", desc: "Stored pressure for bursts.", w: 1, h: 1, mass: 18, hp: 120, cost: 150, shape: "box", armor: 1.0, ports: [P(2, 0.5, "fluid", "io")] },
  { id: "hyd_valve", name: "Valve Block", cat: "hydraulics", desc: "Signal-controlled fluid routing.", w: 1, h: 1, mass: 12, hp: 120, cost: 190, shape: "box", armor: 1.0, ports: [P(0, 0.5, "fluid", "io"), P(2, 0.5, "fluid", "io"), P(1, 0.5, "data", "in")] },
];

// extra fields used by the builder/sim that only some parts carry
export interface PartDefExtra {
  hinge?: boolean;
  turret?: boolean;
  slope?: boolean;
  reactive?: boolean;
  heatProof?: boolean;
  barrel?: boolean;
  ammo?: boolean;
  track?: { grip: number };
}

export const PART_MAP: Record<string, PartDef> = {};
export const PART_EXTRA: Record<string, PartDefExtra> = {};
for (const def of PARTS) {
  PART_MAP[def.id] = def;
  const ex: PartDefExtra = {};
  const anyDef = def as PartDef & PartDefExtra;
  for (const k of ["hinge", "turret", "slope", "reactive", "heatProof", "barrel", "ammo", "track"] as const) {
    if (anyDef[k] !== undefined) (ex as Record<string, unknown>)[k] = anyDef[k];
  }
  PART_EXTRA[def.id] = ex;
}

export function part(id: string): PartDef {
  const d = PART_MAP[id];
  if (!d) throw new Error(`unknown part ${id}`);
  return d;
}

export const CATEGORY_LIST: { id: Category; name: string }[] = [
  { id: "structure", name: "STRUCTURE" },
  { id: "motion", name: "MOTION" },
  { id: "electrical", name: "ELECTRICAL" },
  { id: "control", name: "CONTROL" },
  { id: "sensors", name: "SENSORS" },
  { id: "weapons", name: "WEAPONS" },
  { id: "armour", name: "ARMOUR" },
  { id: "utility", name: "UTILITY" },
  { id: "hydraulics", name: "HYDRAULICS" },
];

export const CELL = 0.5; // meters per grid cell
