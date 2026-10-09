/**
 * Where things are on the desk (world units, tabletop at y = 0, +z towards the
 * viewer): the table, the seats around it (agents sit at the table, head and
 * shoulders above the top), and the miniature cities fitted into its centre.
 * TABLE, CITY_SCALE and AVATAR_SCALE are the knobs for proportions.
 */
import type { CityLayout } from "@/lib/city-layout";

export type XZ = { x: number; z: number };

/** The tabletop (w × d) and its height above the floor. */
export const TABLE = { w: 26, d: 17, h: 11 };
/** Share of the tabletop (each way) the miniature cities may fill, centred. */
export const CITY_SCALE = 0.55;
/** Avatar size: 1 = the 2.4-unit-tall model; 3.3 seats a person at this table. */
export const AVATAR_SCALE = 3.3;
/** Avatar-local height that sits level with the tabletop (just under the shoulders). */
const SEAT_LINE = 0.85;
/** Root height of a seated avatar, so head and shoulders show above the top. */
export const SEAT_Y = -SEAT_LINE * AVATAR_SCALE;

const HW = TABLE.w / 2;
const HD = TABLE.d / 2;

export const LAMP = { x: -HW + 2.2, z: -HD + 2 };
export const MUG = { x: HW - 2.4, z: -HD + 2.2 };
export const TOWER = { x: HW - 6, z: HD - 2.4 };
export const BEACON = { x: -HW + 6, z: HD - 2.4 };
export const PAPERS = { x: -2.5, z: HD - 2.2 };
/** The whiteboard stands behind the table. */
/** Its bottom edge clears the back row's heads and labels, as seen from the default camera. */
export const BOARD = { x: 0, z: -HD - 9, w: 28, h: 13, y: 8.5 };

/** Where the cities go. */
export const PLATE = { x0: -HW * CITY_SCALE, x1: HW * CITY_SCALE, z0: -HD * CITY_SCALE, z1: HD * CITY_SCALE };
export const PLATE_H = 0.12;

export type Seat = {
  x: number;
  z: number;
  yaw: number;
  /** Unit vector from the seat into the table. */
  nx: number;
  nz: number;
};

/**
 * Seats around the table: the back edge first (facing the camera), then the
 * sides, then a second row behind the back. The front (camera side) stays
 * free unless all of those are taken.
 */
export function seatAt(i: number): Seat {
  const gap = AVATAR_SCALE * 1.45;
  const out = AVATAR_SCALE * 0.32; // chest at the edge
  const back = Math.max(1, Math.floor((TABLE.w - 4) / gap));
  const side = Math.max(1, Math.floor((TABLE.d - 4) / gap));
  const along = (n: number, k: number) => -((n - 1) * gap) / 2 + k * gap;
  if (i < back) return { x: along(back, i), z: -HD - out, yaw: 0, nx: 0, nz: 1 };
  i -= back;
  if (i < side * 2) {
    const k = Math.floor(i / 2);
    return i % 2 === 0
      ? { x: -HW - out, z: along(side, k), yaw: Math.PI / 2, nx: 1, nz: 0 }
      : { x: HW + out, z: along(side, k), yaw: -Math.PI / 2, nx: -1, nz: 0 };
  }
  i -= side * 2;
  if (i < back - 1) return { x: along(back, i) + gap / 2, z: -HD - out - gap * 0.8, yaw: 0, nx: 0, nz: 1 };
  i -= back - 1;
  return { x: along(back, i % back), z: HD + out, yaw: Math.PI, nx: 0, nz: -1 };
}

// ── Miniature cities ─────────────────────────────────────────────────────────

export type MiniCities = {
  /** layout x/z → world */
  s: number;
  hs: number;
  ox: number;
  oz: number;
  plates: { name: string; x: number; z: number; w: number; d: number }[];
  /** Building top centre in world units, by layout index. */
  top: (i: number) => { x: number; y: number; z: number };
};

export function miniCities(layout: CityLayout): MiniCities {
  const cs = layout.cities;
  const minX = Math.min(...cs.map((c) => c.x), 0);
  const maxX = Math.max(...cs.map((c) => c.x + c.w), 1);
  const minZ = Math.min(...cs.map((c) => c.z), 0);
  const maxZ = Math.max(...cs.map((c) => c.z + c.d), 1);
  const pw = PLATE.x1 - PLATE.x0;
  const pd = PLATE.z1 - PLATE.z0;
  const s = Math.min(pw / (maxX - minX), pd / (maxZ - minZ), 0.25);
  const maxH = Math.max(1, ...layout.buildings.map((b) => b.h));
  // Miniatures: the tallest building about a hand high next to the avatars.
  const hs = s * Math.min(2, Math.max(1, (AVATAR_SCALE * 0.35) / (maxH * s)));
  const ox = PLATE.x0 + (pw - (maxX - minX) * s) / 2 - minX * s;
  const oz = PLATE.z0 + (pd - (maxZ - minZ) * s) / 2 - minZ * s;
  return {
    s,
    hs,
    ox,
    oz,
    plates: cs.map((c) => ({ name: c.name, x: ox + (c.x + c.w / 2) * s, z: oz + (c.z + c.d / 2) * s, w: c.w * s + 0.3, d: c.d * s + 0.3 })),
    top: (i) => {
      const b = layout.buildings[i];
      return { x: ox + b.x * s, y: PLATE_H + b.h * hs, z: oz + b.z * s };
    },
  };
}
