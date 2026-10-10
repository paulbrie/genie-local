/**
 * Where things are on the desk (world units, tabletop at y = 0, +z towards the
 * viewer): the table at a normal height for the avatars, the floor they stand
 * on, the seats around it (feet on the floor, head and shoulders above the
 * top), the miniature cities fitted into its centre, and the paths left free
 * for walking. AVATAR_SCALE, BODY and TABLE.r are the knobs for proportions.
 */
import * as THREE from "three";

import type { CityLayout } from "@/lib/city-layout";

export type XZ = { x: number; z: number };

/** Avatar size: 1 = the 2.41-unit-tall model; 3.3 seats a person at this table. */
export const AVATAR_SCALE = 3.3;
/**
 * The avatar model's own measures (model units, feet at 0): standing height, the
 * hips (the legs' pivot), the shoulders, hip to sole, and the upper arm. A chibi
 * body: the head is 1.05 of the 2.41, so the shoulders are at 45 % of the height.
 */
export const BODY = { h: 2.41, hip: 0.5, shoulder: 1.08, leg: 0.53, upperArm: 0.26 };
/** A standing person (world units; "1.75 m"). */
export const PERSON_H = BODY.h * AVATAR_SCALE;
/** Seated, the straight legs (no knees) lean this far forward from straight down, under the table's edge (radians). */
export const SEATED_LEG = 0.25;
/** Seated with feet on the floor: the hips' height above it. */
const SEAT_HIP = BODY.leg * AVATAR_SCALE * Math.cos(SEATED_LEG);
/**
 * The table's height above the floor, at these bodies' seated elbow height (the
 * user's choice, T96): forearms rest on the top, as people sit at a table. About
 * 0.35 of a standing person here; a human's 0.75/1.75 would put the top level
 * with these short-bodied avatars' shoulders.
 */
export const TABLE_HEIGHT = SEAT_HIP + (BODY.shoulder - BODY.hip - BODY.upperArm) * AVATAR_SCALE;
/** The round tabletop (radius) and its height above the floor; 16 leaves the cities a 10.5-unit disc. */
export const TABLE = { r: 16, h: TABLE_HEIGHT };
/** The floor everyone stands on (the tabletop is at 0). */
export const FLOOR_Y = -TABLE.h;
/**
 * The miniature cities fit within this share of the table's radius, centred: 0.66 × 16 = 10.56,
 * which clears the props in the front gap (inner edges ≥ 11) and the laptops (≥ 13.6).
 */
export const CITY_SCALE = 0.66;
/** Most world units per layout unit, so a lone small project doesn't fill the table. */
const MAX_CITY_S = 0.35;
/** Between packed cities, in layout units (~0.8 world units at a typical scale). */
const PACK_GAP = 3;
/** Seats keep out of this arc on the camera side (+z), so no head hides the cities. */
const FRONT_GAP = (120 * Math.PI) / 180;
/** Root height of a seated avatar (its feet when standing): hips at SEAT_HIP above the floor. */
export const SEAT_Y = FLOOR_Y + SEAT_HIP - BODY.hip * AVATAR_SCALE;

/** A point on the table at angle `phi` (0 = the back, positive clockwise seen from above) and radius `r`. */
const polar = (phi: number, r: number) => ({ x: r * Math.sin(phi), z: -r * Math.cos(phi) });
const deg = (d: number) => (d * Math.PI) / 180;

// Props on the free ring: the front gap holds the low ones (papers, beacon); the tall lamp stands at
// the back, between the seats, where it hides nothing. Commits are books on the shelf (T95).
export const PAPERS = polar(deg(180), TABLE.r - 3.1);
export const BEACON = polar(deg(-146), TABLE.r - 3.5);
export const LAMP = polar(0, TABLE.r - 2.1);
/** The whiteboard stands behind the table, its bottom above a standing avatar's head, so it reads over the back seats. */
export const BOARD = { x: 0, z: -TABLE.r - 9, w: 28, h: 13, y: 8.5 };
/** How far from the table's centre a chair reaches (its back and its foot, behind the seat). */
export const CHAIR_R = TABLE.r + AVATAR_SCALE * 0.32 + AVATAR_SCALE * (0.2 + 0.5);
/** Free floor for walking: a ring around the chairs, clear to the whiteboard; and the strip in front of the board. */
export const WALK = { r0: CHAIR_R + 0.5, r1: CHAIR_R + 3.5 };
/** Where the bookshelf stands (T95): on the floor left of the whiteboard, facing the table (world x/z, width and depth). */
export const SHELF_SPOT = { x: BOARD.x - BOARD.w / 2 - 1.4 - 9.8 / 2, z: BOARD.z + 1, w: 9.8, d: 2.6 };
/**
 * The bookshelf (T133: 1.4× T95's): a shelf per project on the table (shelf.ts), `gap` the room between two
 * boards; it grows taller with the projects, up to MAX_SHELVES, the top one still in reach of a person.
 */
export const SHELF = { ...SHELF_SPOT, gap: 1.55, board: 0.18, side: 0.24 };
/** Where someone stands to shelve a book: in front of the shelf, facing it. */
export const SHELF_STAND = { x: SHELF_SPOT.x, z: SHELF_SPOT.z + SHELF_SPOT.d / 2 + AVATAR_SCALE * 0.45 };

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

/** An agent's browser label (T102/T114): over the table between its laptop and the cities. */
export const BROWSER = { r: TABLE.r - 3.8 };
export function browserAt(seat: Seat): XZ {
  const inward = TABLE.r + AVATAR_SCALE * 0.32 - BROWSER.r;
  return { x: seat.x + seat.nx * inward, z: seat.z + seat.nz * inward };
}
/** Browsers nobody at the table owns: one label in the front gap, between the papers and the commit tower. */
export const UNOWNED_BROWSERS = polar(deg(163), TABLE.r - 3.7);

/** Top of the laptop's lid, where its threads to the cities start. */
export function laptopTop(seat: Seat): THREE.Vector3 {
  const c = laptopAt(seat);
  return new THREE.Vector3(c.x + seat.nx * (LAPTOP.d / 2 + 0.3), LAPTOP.lid, c.z + seat.nz * (LAPTOP.d / 2 + 0.3));
}

// ── Miniature cities ─────────────────────────────────────────────────────────

export type MiniCities = {
  /** layout units → world */
  s: number;
  hs: number;
  /** A point (layout x, z) in a repo's city → where it is on the table (world x/z). */
  at: (repo: string, x: number, z: number) => XZ;
  plates: { name: string; x: number; z: number; w: number; d: number }[];
  /** Building top centre in world units, by layout index. */
  top: (i: number) => { x: number; y: number; z: number };
};

type Box = { repo: string; x: number; z: number; w: number; d: number };

/** The biggest in the middle, then alternating outwards (… 3 1 0 2 4 …), for items sorted biggest first. */
function centreOut<T>(items: T[]): T[] {
  const out: T[] = [];
  items.forEach((x, i) => (i % 2 ? out.unshift(x) : out.push(x)));
  return out;
}

/**
 * Packs the cities (squares of any size, side by side in the layout) into rows on
 * the round table: biggest first, the widest row and the biggest city of each row
 * in the middle, where the circle is widest. Tries every row count and keeps the
 * one that lets the cities be largest inside radius `R`. Returns the scale (world
 * units per layout unit) and each repo's shift (layout units) to its packed place.
 */
export function packCities(cities: Box[], R: number, gap = PACK_GAP, sMax = MAX_CITY_S): { s: number; shift: Map<string, { dx: number; dz: number }> } {
  const sorted = [...cities].sort((a, b) => b.w * b.d - a.w * a.d || a.repo.localeCompare(b.repo));
  const total = sorted.reduce((n, c) => n + c.w, 0) + gap * Math.max(0, sorted.length - 1);
  let best: { s: number; shift: Map<string, { dx: number; dz: number }> } | null = null;
  for (let k = 1; k <= sorted.length; k++) {
    // Greedy rows of about total / k each.
    const rows: Box[][] = [[]];
    let w = 0;
    for (const c of sorted) {
      const row = rows[rows.length - 1];
      if (row.length && w + gap + c.w > total / k && rows.length < k) {
        rows.push([c]);
        w = c.w;
      } else {
        row.push(c);
        w += (row.length > 1 ? gap : 0) + c.w;
      }
    }
    // Centres in packed space, rows stacked along z, each row centred on x.
    const placed: { c: Box; x: number; z: number }[] = [];
    let z = 0;
    for (const row of centreOut(rows)) {
      const depth = Math.max(...row.map((c) => c.d));
      let x = -(row.reduce((n, c) => n + c.w, 0) + gap * (row.length - 1)) / 2;
      for (const c of centreOut(row)) {
        placed.push({ c, x: x + c.w / 2, z: z + depth / 2 });
        x += c.w + gap;
      }
      z += depth + gap;
    }
    // Slide the stack along z so its farthest corner is as near the centre as can be (convex: ternary search).
    const reach = (dz: number) => Math.max(...placed.map((p) => Math.hypot(Math.abs(p.x) + p.c.w / 2, Math.abs(p.z + dz) + p.c.d / 2)));
    let lo = -z;
    let hi = 0;
    for (let n = 0; n < 60; n++) {
      const a = lo + (hi - lo) / 3;
      const b = hi - (hi - lo) / 3;
      if (reach(a) < reach(b)) hi = b;
      else lo = a;
    }
    const dz = (lo + hi) / 2;
    const s = Math.min(sMax, R / Math.max(1e-6, reach(dz)));
    if (!best || s > best.s + 1e-9) {
      const shift = new Map(placed.map((p) => [p.c.repo, { dx: p.x - (p.c.x + p.c.w / 2), dz: p.z + dz - (p.c.z + p.c.d / 2) }]));
      best = { s, shift };
    }
  }
  return best ? { s: best.s, shift: best.shift } : { s: sMax, shift: new Map() };
}

export function miniCities(layout: CityLayout): MiniCities {
  // A margin for the plates' rims (0.15 a side).
  const { s, shift } = packCities(layout.cities, CITY_SCALE * TABLE.r - 0.25);
  const maxH = Math.max(1, ...layout.buildings.map((b) => b.h));
  // Miniatures: the tallest building about a hand high next to the avatars.
  const hs = s * Math.min(2, Math.max(1, (AVATAR_SCALE * 0.35) / (maxH * s)));
  const at = (repo: string, x: number, z: number): XZ => {
    const d = shift.get(repo);
    return { x: (x + (d?.dx ?? 0)) * s, z: (z + (d?.dz ?? 0)) * s };
  };
  return {
    s,
    hs,
    at,
    plates: layout.cities.map((c) => ({ name: c.name, ...at(c.repo, c.x + c.w / 2, c.z + c.d / 2), w: c.w * s + 0.3, d: c.d * s + 0.3 })),
    top: (i) => {
      const b = layout.buildings[i];
      const p = at(b.repo, b.x, b.z);
      return { x: p.x, y: PLATE_H + b.h * hs, z: p.z };
    },
  };
}

// ── Neighbourhood names ──────────────────────────────────────────────────────

/** A neighbourhood's (folder's) name shows once the camera is closer than this to it (world units)… */
export const DISTRICT_LABEL_DIST = 24;
/** …and each level deeper needs this much closer again (24, 14.4, 8.6…). */
const DISTRICT_DEPTH_FALLOFF = 0.6;
/** Folders narrower than this on the table (world units) get no name: there's no room for one. */
const DISTRICT_MIN_SIZE = 0.9;

/** Where each neighbourhood's name goes (its centre, just over the plate) and the squared distance it shows within (0: never). */
export function districtSpots(layout: CityLayout, mini: MiniCities): { x: Float32Array; y: Float32Array; z: Float32Array; near2: Float32Array; names: string[] } {
  const n = layout.districts.length;
  const out = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), near2: new Float32Array(n), names: new Array<string>(n) };
  layout.districts.forEach((d, i) => {
    const p = mini.at(d.repo, d.x + d.w / 2, d.z + d.d / 2);
    out.x[i] = p.x;
    out.y[i] = PLATE_H + 0.1;
    out.z[i] = p.z;
    const near = DISTRICT_LABEL_DIST * DISTRICT_DEPTH_FALLOFF ** d.depth;
    out.near2[i] = Math.min(d.w, d.d) * mini.s < DISTRICT_MIN_SIZE ? 0 : near * near;
    out.names[i] = d.dir.split("/").pop() ?? d.dir;
  });
  return out;
}

/**
 * The spots within their show distance of (px, py, pz), nearest first, at most
 * `idx.length` of them, written into `idx` (and their squared distances into
 * `d2`); returns how many. Allocates nothing, for use every frame.
 */
export function nearestSpots(
  px: number,
  py: number,
  pz: number,
  spots: { x: Float32Array; y: Float32Array; z: Float32Array; near2: Float32Array },
  idx: Int32Array,
  d2: Float32Array,
): number {
  const cap = idx.length;
  let n = 0;
  for (let i = 0; i < spots.near2.length; i++) {
    const dx = spots.x[i] - px;
    const dy = spots.y[i] - py;
    const dz = spots.z[i] - pz;
    const q = dx * dx + dy * dy + dz * dz;
    if (q >= spots.near2[i] || (n === cap && q >= d2[n - 1])) continue;
    // Insertion into the sorted list, dropping the farthest when full.
    let j = n < cap ? n++ : cap - 1;
    while (j > 0 && d2[j - 1] > q) {
      d2[j] = d2[j - 1];
      idx[j] = idx[j - 1];
      j--;
    }
    d2[j] = q;
    idx[j] = i;
  }
  return n;
}
