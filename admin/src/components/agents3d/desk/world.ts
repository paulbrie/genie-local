/**
 * Where things are on the desk (world units, tabletop at y = 0, +z towards the
 * viewer): the table, the seats around it (agents sit at the table, head and
 * shoulders above the top), and the miniature cities fitted into its centre.
 * TABLE, CITY_SCALE and AVATAR_SCALE are the knobs for proportions.
 */
import * as THREE from "three";

import type { CityLayout } from "@/lib/city-layout";

export type XZ = { x: number; z: number };

/** The round tabletop (radius) and its height above the floor. */
export const TABLE = { r: 13.5, h: 11 };
/** The miniature cities fit within this share of the table's diameter, centred. */
export const CITY_SCALE = 0.55;
/** Seats keep out of this arc on the camera side (+z), so no head hides the cities. */
const FRONT_GAP = (120 * Math.PI) / 180;
/** Avatar size: 1 = the 2.4-unit-tall model; 3.3 seats a person at this table. */
export const AVATAR_SCALE = 3.3;
/** Avatar-local height that sits level with the tabletop (just under the shoulders). */
const SEAT_LINE = 0.85;
/** Root height of a seated avatar, so head and shoulders show above the top. */
export const SEAT_Y = -SEAT_LINE * AVATAR_SCALE;

/** A point on the table at angle `phi` (0 = the back, positive clockwise seen from above) and radius `r`. */
const polar = (phi: number, r: number) => ({ x: r * Math.sin(phi), z: -r * Math.cos(phi) });
const deg = (d: number) => (d * Math.PI) / 180;

// Props on the free ring: the front gap holds the low ones (tower, papers, beacon, mug); the tall lamp
// stands at the back, between the seats, where it hides nothing.
export const TOWER = polar(deg(146), 10);
export const PAPERS = polar(deg(180), 10.4);
export const BEACON = polar(deg(-146), 10);
export const LAMP = polar(0, 11.4);
export const MUG = polar(deg(-164), 11.3);
/** The whiteboard stands behind the table. */
export const BOARD = { x: 0, z: -TABLE.r - 9, w: 28, h: 13, y: 8.5 };

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
 * Seat i of n: evenly spaced around the table, all facing its centre, leaving
 * FRONT_GAP open on the camera side. Past ~13 people the gap fills too.
 */
export function seatAt(i: number, n: number): Seat {
  const minStep = (AVATAR_SCALE * 1.45) / (TABLE.r + AVATAR_SCALE * 0.32); // a seat's width, as an angle
  const open = 2 * Math.PI - FRONT_GAP;
  const span = n * minStep > open ? Math.min(2 * Math.PI - minStep, n * minStep) : open;
  const phi = -span / 2 + (span * (i + 0.5)) / Math.max(1, n);
  const p = polar(phi, TABLE.r + AVATAR_SCALE * 0.32); // chest at the edge
  return { x: p.x, z: p.z, yaw: -phi, nx: -Math.sin(phi), nz: Math.cos(phi) };
}

/** Each agent's laptop, on the table in front of its seat. */
export const LAPTOP = { w: 3.0, d: 2.0, lid: 1.9 };

/** Centre of the laptop's base in front of a seat. */
export function laptopAt(seat: Seat): XZ {
  const inward = AVATAR_SCALE * 0.32 + 0.35 + LAPTOP.d / 2;
  return { x: seat.x + seat.nx * inward, z: seat.z + seat.nz * inward };
}

/** Top of the laptop's lid, where its threads to the cities start. */
export function laptopTop(seat: Seat): THREE.Vector3 {
  const c = laptopAt(seat);
  return new THREE.Vector3(c.x + seat.nx * (LAPTOP.d / 2 + 0.3), LAPTOP.lid, c.z + seat.nz * (LAPTOP.d / 2 + 0.3));
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
  // The largest rectangle of the layout's aspect inside a circle of CITY_SCALE × the diameter.
  const R = CITY_SCALE * TABLE.r;
  const aspect = (maxX - minX) / (maxZ - minZ);
  const pd = (2 * R) / Math.sqrt(1 + aspect * aspect);
  const pw = pd * aspect;
  const PLATE = { x0: -pw / 2, z0: -pd / 2 };
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
