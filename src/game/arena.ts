// SCRAP & STEEL — game/arena.ts
// Arenas: side-view environments with physical obstacles.

import planck from "planck-js";
import { CAT_TERRAIN } from "./physics";

export interface ArenaDef {
  id: string;
  name: string;
  desc: string;
  width: number; // meters
  sky: [string, string]; // gradient
  hills: string;
  obstacles: { x: number; y: number; w: number; h: number; kind: "crate" | "wall" | "ramp" | "platform" }[];
}

export const ARENAS: Record<string, ArenaDef> = {
  scrapyard: {
    id: "scrapyard", name: "SCRAPYARD", desc: "Industrial junkyard. Crates and ramps.",
    width: 44, sky: ["#232b33", "#141a20"], hills: "#1c242b",
    obstacles: [
      { x: 14, y: 0, w: 1, h: 1, kind: "crate" },
      { x: 15, y: 0, w: 1, h: 1, kind: "crate" },
      { x: 14.5, y: 1, w: 1, h: 1, kind: "crate" },
      { x: 30, y: 0, w: 1, h: 1, kind: "crate" },
      { x: 22, y: 0, w: 3, h: 0.6, kind: "ramp" },
      { x: 36, y: 0, w: 0.6, h: 2.4, kind: "wall" },
    ],
  },
  factory: {
    id: "factory", name: "FACTORY", desc: "Indoor floor. Platforms and machinery.",
    width: 40, sky: ["#26221c", "#151210"], hills: "#211c16",
    obstacles: [
      { x: 10, y: 0, w: 4, h: 1.2, kind: "platform" },
      { x: 26, y: 0, w: 4, h: 2.2, kind: "platform" },
      { x: 19, y: 0, w: 0.8, h: 1.6, kind: "wall" },
      { x: 33, y: 0, w: 1, h: 1, kind: "crate" },
    ],
  },
  desert: {
    id: "desert", name: "DESERT", desc: "Open terrain. Long sight lines.",
    width: 52, sky: ["#3a3020", "#1c160e"], hills: "#2e2618",
    obstacles: [
      { x: 18, y: 0, w: 4, h: 0.5, kind: "ramp" },
      { x: 34, y: 0, w: 4, h: 0.5, kind: "ramp" },
      { x: 26, y: 0, w: 1, h: 1, kind: "crate" },
    ],
  },
  range: {
    id: "range", name: "TEST RANGE", desc: "Flat field with target dummies.",
    width: 46, sky: ["#22262e", "#12151a"], hills: "#1a1e24",
    obstacles: [
      { x: 24, y: 0, w: 0.8, h: 1.4, kind: "wall" },
    ],
  },
};

export function buildArenaWorld(world: planck.World, arena: ArenaDef) {
  const floor = world.createBody({ type: "static", position: planck.Vec2(arena.width / 2, -0.5) });
  floor.createFixture(planck.Box(arena.width / 2 + 4, 0.5), { friction: 0.9, filterCategoryBits: CAT_TERRAIN, userData: "terrain" });

  // walls
  for (const [x, hw] of [[-1, 1], [arena.width + 1, 1]] as [number, number][]) {
    const wall = world.createBody({ type: "static", position: planck.Vec2(x, 3) });
    wall.createFixture(planck.Box(hw, 5), { friction: 0.4, filterCategoryBits: CAT_TERRAIN, userData: "terrain" });
  }

  for (const ob of arena.obstacles) {
    const b = world.createBody({
      type: ob.kind === "crate" ? "dynamic" : "static",
      position: planck.Vec2(ob.x + ob.w / 2, ob.h / 2),
    });
    if (ob.kind === "ramp") {
      b.createFixture(planck.Polygon([
        planck.Vec2(-ob.w / 2, -ob.h / 2), planck.Vec2(ob.w / 2, -ob.h / 2), planck.Vec2(ob.w / 2, ob.h / 2),
      ]), { friction: 0.85, filterCategoryBits: CAT_TERRAIN, userData: "terrain" });
    } else {
      b.createFixture(planck.Box(ob.w / 2, ob.h / 2), {
        friction: 0.7,
        density: ob.kind === "crate" ? 0.6 : 10,
        filterCategoryBits: CAT_TERRAIN,
        userData: ob.kind === "crate" ? "crate" : "terrain",
      });
    }
  }
}
