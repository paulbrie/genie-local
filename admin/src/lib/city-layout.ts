/**
 * Lays out repos as cities: a squarified treemap per repo, directories as
 * nested districts, files as buildings. Footprint grows with log(size) so tiny
 * files stay visible and huge ones don't swallow a district; height likewise.
 * Pure: (repos) → boxes in world units on the XZ plane.
 */
import type { RepoLayout } from "@/lib/agents3d-types";
import { fileKey } from "@/lib/agents3d-timeline";

export type Building = { key: string; repo: string; path: string; x: number; z: number; w: number; d: number; h: number; ext: string };
export type District = { repo: string; dir: string; depth: number; x: number; z: number; w: number; d: number };
export type CityBounds = { repo: string; name: string; x: number; z: number; w: number; d: number };
export type CityLayout = {
  buildings: Building[];
  index: Map<string, number>;
  districts: District[];
  cities: CityBounds[];
  /** Overall extent, for camera framing. */
  size: number;
};

type Node = { name: string; dir: string; weight: number; children: Map<string, Node>; file?: { p: string; s: number } };

const footprint = (s: number) => 1 + Math.log2(1 + s / 2048);
const height = (s: number) => 0.4 + Math.log2(1 + s / 512) * 0.55;
const PAD = 0.35; // street width inside a district
const GAP = 8; // between cities

function tree(files: { p: string; s: number }[]): Node {
  const root: Node = { name: "", dir: "", weight: 0, children: new Map() };
  for (const f of files) {
    const parts = f.p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!cur.children.has(name))
        cur.children.set(name, { name, dir: cur.dir ? `${cur.dir}/${name}` : name, weight: 0, children: new Map() });
      cur = cur.children.get(name)!;
    }
    cur.children.set(`\0${parts[parts.length - 1]}`, { name: parts[parts.length - 1], dir: cur.dir, weight: footprint(f.s), children: new Map(), file: f });
  }
  const sum = (n: Node): number => {
    if (n.file) return n.weight;
    n.weight = 0;
    for (const c of n.children.values()) n.weight += sum(c);
    return n.weight;
  };
  sum(root);
  return root;
}

type Rect = { x: number; z: number; w: number; d: number };

/** Squarified treemap (Bruls et al.): items sorted by weight desc → rects filling `r`. */
function squarify(weights: number[], r: Rect): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Rect[] = new Array(weights.length);
  if (total <= 0 || r.w <= 0 || r.d <= 0) {
    weights.forEach((_, i) => (out[i] = { x: r.x, z: r.z, w: 0, d: 0 }));
    return out;
  }
  const scale = (r.w * r.d) / total;
  const areas = weights.map((w) => w * scale);
  let { x, z, w, d } = r;
  let i = 0;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row);
    const mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (i < areas.length) {
    const side = Math.min(w, d);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const s = row.reduce((a, b) => a + b, 0);
    if (w >= d) {
      // column on the left
      const cw = s / d;
      let cz = z;
      row.forEach((a, k) => {
        const h = a / cw;
        out[i + k] = { x, z: cz, w: cw, d: h };
        cz += h;
      });
      x += cw;
      w -= cw;
    } else {
      const rd = s / w;
      let cx = x;
      row.forEach((a, k) => {
        const rw = a / rd;
        out[i + k] = { x: cx, z, w: rw, d: rd };
        cx += rw;
      });
      z += rd;
      d -= rd;
    }
    i = j;
  }
  return out;
}

export function layoutCities(repos: RepoLayout[]): CityLayout {
  const buildings: Building[] = [];
  const districts: District[] = [];
  const cities: CityBounds[] = [];
  let cursor = 0;

  for (const repo of repos) {
    const root = tree(repo.files);
    if (root.weight === 0) continue;
    // Area ∝ weight, with room for streets.
    const side = Math.sqrt(root.weight) * 1.35;
    const rect: Rect = { x: cursor, z: -side / 2, w: side, d: side };
    cities.push({ repo: repo.id, name: repo.name, ...rect });

    const place = (n: Node, r: Rect, depth: number) => {
      const kids = [...n.children.values()].sort((a, b) => b.weight - a.weight);
      const rects = squarify(
        kids.map((k) => k.weight),
        r,
      );
      kids.forEach((k, i) => {
        const kr = rects[i];
        if (k.file) {
          const inset = Math.min(kr.w, kr.d) * 0.12;
          const ext = k.name.includes(".") ? k.name.split(".").pop()!.toLowerCase() : "";
          buildings.push({
            key: fileKey(repo.id, k.file.p),
            repo: repo.id,
            path: k.file.p,
            x: kr.x + kr.w / 2,
            z: kr.z + kr.d / 2,
            w: Math.max(0.05, kr.w - inset * 2),
            d: Math.max(0.05, kr.d - inset * 2),
            h: height(k.file.s),
            ext,
          });
        } else {
          districts.push({ repo: repo.id, dir: k.dir, depth, ...kr });
          const pad = Math.min(PAD, kr.w / 6, kr.d / 6);
          place(k, { x: kr.x + pad, z: kr.z + pad, w: kr.w - pad * 2, d: kr.d - pad * 2 }, depth + 1);
        }
      });
    };
    place(root, rect, 0);
    cursor += side + GAP;
  }

  // Centre everything on the origin.
  const span = Math.max(cursor - GAP, 1);
  const dx = -span / 2;
  for (const b of buildings) b.x += dx;
  for (const d of districts) d.x += dx;
  for (const c of cities) c.x += dx;
  const index = new Map(buildings.map((b, i) => [b.key, i]));
  const depth = Math.max(1, ...cities.map((c) => c.d));
  return { buildings, index, districts, cities, size: Math.max(span, depth) };
}
