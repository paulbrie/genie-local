/**
 * The cities seen isometrically (T163): the 3D views' layout (city-layout: files as buildings on a treemap, folders
 * as districts) drawn as small blocks, height by size (capped), on a flat 2D canvas. Pure: the screen shapes, in one
 * back-to-front order worked out once per layout, and what lies over what (to redraw a lit block's neighbours in
 * front of it), and which block is under a point.
 */
import type { Building, CityLayout } from "@/lib/city-layout";

export type P2 = { x: number; y: number };
/** world → screen units: x across, z into the screen, h up */
const C = Math.cos(Math.PI / 6), S = 0.5;
/** blocks no taller than this (world units), so a big file doesn't hide its street */
export const MAX_H = 3;
/** heights drawn this much taller than the 3D's, so size reads at a glance */
const H_SCALE = 1.4;

export const iso = (x: number, z: number, h = 0): P2 => ({ x: (x - z) * C, y: (x + z) * S - h });

export type IsoBlock = {
  /** index in layout.buildings */
  i: number;
  key: string;
  /** top face, left face (facing +z), right face (facing +x): screen polygons */
  top: P2[];
  left: P2[];
  right: P2[];
  /** its screen box, and the point over its top's middle (where an agent's thread ends) */
  box: { x0: number; y0: number; x1: number; y1: number };
  peak: P2;
  ext: string;
};
export type IsoDistrict = { pts: P2[]; depth: number; dir: string; repo: string };
export type IsoMap = {
  blocks: IsoBlock[];
  /** layout index → position in `blocks` (drawing order) */
  order: Map<number, number>;
  districts: IsoDistrict[];
  cities: { name: string; repo: string; at: P2; ground: P2[] }[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
};

const quad = (x0: number, z0: number, x1: number, z1: number, h: number) => [iso(x0, z0, h), iso(x1, z0, h), iso(x1, z1, h), iso(x0, z1, h)];

export function blockOf(b: Building, i: number): IsoBlock {
  const h = Math.min(MAX_H, b.h) * H_SCALE;
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const top = quad(x0, z0, x1, z1, h);
  // (seen from +x +z: the faces at z1 and x1 show)
  const left = [iso(x0, z1, h), iso(x1, z1, h), iso(x1, z1, 0), iso(x0, z1, 0)];
  const right = [iso(x1, z0, h), iso(x1, z1, h), iso(x1, z1, 0), iso(x1, z0, 0)];
  const all = [...top, ...left, ...right];
  const box = { x0: Math.min(...all.map((p) => p.x)), y0: Math.min(...all.map((p) => p.y)), x1: Math.max(...all.map((p) => p.x)), y1: Math.max(...all.map((p) => p.y)) };
  return { i, key: b.key, top, left, right, box, peak: iso(b.x, b.z, h), ext: b.ext };
}

/** the layout seen isometrically, blocks back to front */
export function isoMap(layout: CityLayout): IsoMap {
  const blocks = layout.buildings.map(blockOf);
  // (back to front: by the far corner's x + z; blocks on a treemap never overlap on the ground)
  const far = (b: Building) => b.x + b.w / 2 + b.z + b.d / 2;
  blocks.sort((a, b) => far(layout.buildings[a.i]) - far(layout.buildings[b.i]) || a.i - b.i);
  const order = new Map(blocks.map((b, n) => [b.i, n]));
  const districts = layout.districts
    .slice()
    .sort((a, b) => a.depth - b.depth)
    .map((d) => ({ pts: quad(d.x, d.z, d.x + d.w, d.z + d.d, 0), depth: d.depth, dir: d.dir, repo: d.repo }));
  const cities = layout.cities.map((c) => ({ name: c.name, repo: c.repo, at: iso(c.x, c.z), ground: quad(c.x, c.z, c.x + c.w, c.z + c.d, 0) }));
  const pts = [...blocks.flatMap((b) => [{ x: b.box.x0, y: b.box.y0 }, { x: b.box.x1, y: b.box.y1 }]), ...cities.flatMap((c) => c.ground)];
  const bounds = pts.length
    ? { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)) - 2, x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) }
    : { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { blocks, order, districts, cities, bounds };
}

const overlaps = (a: IsoBlock["box"], b: IsoBlock["box"]) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** the blocks to draw for a lit set: each lit one, and every block in front of one that overlaps it on screen, in order */
export function litDrawList(map: IsoMap, lit: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const i of lit) {
    const n = map.order.get(i);
    if (n === undefined) continue;
    out.add(n);
    const b = map.blocks[n].box;
    for (let m = n + 1; m < map.blocks.length; m++) if (overlaps(map.blocks[m].box, b)) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

const inside = (p: P2, poly: P2[]) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};

/** the block drawn at `p` (screen units), front-most first; null if none */
export function blockAt(map: IsoMap, p: P2): IsoBlock | null {
  for (let n = map.blocks.length - 1; n >= 0; n--) {
    const b = map.blocks[n];
    if (p.x < b.box.x0 || p.x > b.box.x1 || p.y < b.box.y0 || p.y > b.box.y1) continue;
    if (inside(p, b.top) || inside(p, b.left) || inside(p, b.right)) return b;
  }
  return null;
}
