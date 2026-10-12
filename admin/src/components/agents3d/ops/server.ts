/**
 * Our server in the Ops view (T209): a rack beyond the commits' belts (the far, top-right side), in the cities' style:
 * a blade a core, lit by that core's load, and three readouts on its side, CPU, MEM (what's available) and DISK, with
 * the Table gauges' thresholds (desk/gauge-levels.ts). Pure: where the rack stands (world units), its blades' and
 * readouts' shapes, the colours for a load, and what the map's fit must take in.
 */
import type { CityBounds } from "@/lib/city-layout";

import { CPU_BAD, CPU_WARN } from "../desk/gauge-levels";
import type { Belt } from "./desks";
import { iso, type P2 } from "./iso";

/** in a desk's units: the rack's width (along x), depth and height, and its gap behind the belts */
export const RACK = { w: 7, d: 7, h: 11, gap: 3 };
/** what the rack is labelled with */
export const HOST = "Taz 2xlarge · 16 vCPU · 32 GB";

export type Rack = { x0: number; x1: number; z0: number; z1: number; h: number; wu: number };

/** the rack: behind the farthest belt (or city, with no belts), centred on the cities' middle */
export function rackOf(cities: CityBounds[], belts: Belt[], wu: number): Rack {
  const x0 = cities.length ? Math.min(...cities.map((c) => c.x)) : 0;
  const x1 = cities.length ? Math.max(...cities.map((c) => c.x + c.w)) : 40;
  const far = belts.length ? Math.min(...belts.map((b) => b.z0)) : cities.length ? Math.min(...cities.map((c) => c.z)) : 0;
  const mid = (x0 + x1) / 2, w = RACK.w * wu, d = RACK.d * wu;
  const z1 = far - RACK.gap * wu;
  return { x0: mid - w / 2, x1: mid + w / 2, z0: z1 - d, z1, h: RACK.h * wu, wu };
}

/** what the fit takes in for the rack alone: its top, and its label over it (screen units) */
export const rackExtent = (r: Rack): P2[] => [iso(r.x0, r.z0, r.h + 3 * r.wu), iso(r.x1, r.z0, r.h + 3 * r.wu), iso(r.x0, r.z1, 0), iso(r.x1, r.z1, 0)];

/** a core's blade colour by its load: dark when idle, through amber, to red (null: no data) */
export function coreColor(pct: number | null): string {
  if (pct === null) return "#1f2937";
  const p = Math.max(0, Math.min(100, pct));
  // (dark slate → amber at CPU_WARN → red at CPU_BAD and over)
  const lerp = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const dark = [30, 41, 59], amber = [245, 158, 11], red = [239, 68, 68];
  const c = p <= CPU_WARN ? lerp(dark, amber, p / CPU_WARN) : lerp(amber, red, Math.min(1, (p - CPU_WARN) / (CPU_BAD - CPU_WARN)));
  return `rgb(${c.join(",")})`;
}

/** the blades on the rack's front (the face towards the viewer, +z): `n` stacked strips, the first at the top (world units, h up) */
export function blades(r: Rack, n: number): { x0: number; x1: number; h0: number; h1: number }[] {
  const pad = 0.5 * r.wu, top = r.h - 1.2 * r.wu, bottom = 0.6 * r.wu, step = (top - bottom) / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => ({ x0: r.x0 + pad, x1: r.x1 - pad, h1: top - i * step - 0.08 * step, h0: top - (i + 1) * step + 0.08 * step }));
}

/** the readouts on the rack's side (the face towards +x): three meters, top to bottom, each a track along z (world units) */
export function meters(r: Rack): { z0: number; z1: number; h0: number; h1: number }[] {
  const pad = 0.5 * r.wu, row = (r.h - 2 * r.wu) / 3;
  return [0, 1, 2].map((i) => {
    const h1 = r.h - 1.6 * r.wu - i * row;
    return { z0: r.z0 + pad, z1: r.z1 - pad, h0: h1 - 1.1 * r.wu, h1 };
  });
}

/** a screen box (the map's iso units, as the fit draws them) */
export type Box = { x0: number; y0: number; x1: number; y1: number };
export const boxOf = (ps: P2[]): Box => ({ x0: Math.min(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), x1: Math.max(...ps.map((p) => p.x)), y1: Math.max(...ps.map((p) => p.y)) });
export const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const grow = (b: Box, m: number): Box => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
/** an iso box's corners */
const corners = (x0: number, x1: number, z0: number, z1: number, h: number) => [0, h].flatMap((y) => [iso(x0, z0, y), iso(x1, z0, y), iso(x0, z1, y), iso(x1, z1, y)]);

/** the readouts' font size (px) at the map's scale `k` (px a unit) */
export const readoutPx = (wu: number, k: number) => Math.max(8, Math.min(12, wu * k * 0.9));

/**
 * The gateway (T214): a low wall with a gate a public port (up to GATES), set apart from the rack, its port numbers
 * and services on plates on its face; the bandwidth over its left end; a cable from it to the rack. Desk units.
 */
export const GATE = { w: 4.4, h: 6, d: 0.8, max: 12 };
export type Gateway = { x0: number; x1: number; z0: number; z1: number; h: number; wu: number; /** gates it has */ n: number; /** the bandwidth's box over it, px */ bw: { w: number; h: number } };

/** a gateway for `n` ports (a gate each, up to GATE.max; one at least), its left end at x0 and its face at z1 (world units) */
export function gatewayAt(x0: number, z1: number, wu: number, n: number): Gateway {
  const k = Math.max(1, Math.min(GATE.max, n));
  return { x0, x1: x0 + (k * GATE.w + 0.6) * wu, z0: z1 - GATE.d * wu, z1, h: GATE.h * wu, wu, n: k, bw: { w: 108, h: 44 } };
}
/** the gate a port goes through on the gateway's face (world units, left to right) */
export function gates(g: Gateway, n: number): { x0: number; x1: number; h0: number; h1: number }[] {
  return Array.from({ length: Math.min(n, g.n) }, (_, i) => ({ x0: g.x0 + (0.5 + i * GATE.w) * g.wu, x1: g.x0 + (0.5 + i * GATE.w + GATE.w - 0.6) * g.wu, h0: 0, h1: (GATE.h - 2.3) * g.wu }));
}
/** what the gateway covers on screen at scale `k`: its wall, and the bandwidth over its left end (iso units) */
export function gatewayBox(g: Gateway, k: number): Box {
  const wall = boxOf(corners(g.x0, g.x1, g.z0, g.z1, g.h)), top = iso(g.x0, g.z1, g.h);
  return { x0: Math.min(wall.x0, top.x - 10 / k), y0: Math.min(wall.y0, top.y - (g.bw.h + 12) / k), x1: Math.max(wall.x1, top.x + (g.bw.w - 10) / k), y1: wall.y1 };
}

/**
 * What the rack, its readouts and its name, the belts with their packages and the cities with their names cover on
 * screen at the whole map's scale `k` (iso units): the gateway must stay clear of all of them.
 */
export function serverObstacles(r: Rack, belts: Belt[], cities: CityBounds[], k: number): Box[] {
  const fs = readoutPx(r.wu, k), out: Box[] = [boxOf(corners(r.x0, r.x1, r.z0, r.z1, r.h))];
  // (its name over it, centred)
  const label = iso((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, r.h + 1.4 * r.wu), lw = (HOST.length * 0.58 * (fs + 1)) / k;
  out.push({ x0: label.x - lw / 2, y0: label.y - (fs + 2) / k, x1: label.x + lw / 2, y1: label.y + 4 / k });
  // (the readouts right of its side, "MEM 22 GB free" the longest)
  for (const m of meters(r)) {
    const at = iso(r.x1, m.z0, (m.h0 + m.h1) / 2);
    out.push({ x0: at.x, y0: at.y - fs / k, x1: at.x + (6 + 16 * 0.62 * fs) / k, y1: at.y + fs / k });
  }
  // (each belt, its packages and their labels on it)
  for (const b of belts) out.push(boxOf(corners(b.x0, b.x1, b.z0, b.z1, b.h + 3.5 * r.wu)));
  // (each city's ground, and its name over its corner)
  for (const c of cities) {
    out.push(boxOf(corners(c.x, c.x + c.w, c.z, c.z + c.d, 0)));
    const at = iso(c.x, c.z), w = (c.name.length * 8 + 8) / k;
    out.push({ x0: at.x - w / 2, y0: at.y - 20 / k, x1: at.x + w / 2, y1: at.y });
  }
  return out;
}

/**
 * Where the gateway goes (T214): behind the rack (away from the belts and the cities), the nearest place, by a few
 * steps back and along, where it overlaps none of `obstacles` (with a margin); none clear: the farthest one tried.
 */
export function placeGateway(r: Rack, obstacles: Box[], k: number, ports: number): Gateway {
  const wu = r.wu, margin = 6 / k;
  let best: Gateway | null = null, last: Gateway | null = null;
  const tries: { dz: number; dx: number }[] = [];
  for (let dz = 4; dz <= 60; dz += 4) for (const dx of [0, 6, -6, 12, -12, 20, -20, 30, -30]) tries.push({ dz, dx });
  tries.sort((a, b) => a.dz + Math.abs(a.dx) * 0.7 - (b.dz + Math.abs(b.dx) * 0.7));
  for (const t of tries) {
    const g = gatewayAt(r.x0 + t.dx * wu, r.z0 - t.dz * wu, wu, ports);
    last = g;
    const box = grow(gatewayBox(g, k), margin);
    // (and its cable to the rack clear too)
    if (!obstacles.some((o) => overlap(o, box)) && cableClear(g, r, obstacles.slice(1))) { best = g; break; }
  }
  return best ?? last!;
}

/**
 * The cable from the gateway to the rack (T214): from the top of the gateway's end nearest the rack, arching over to
 * the middle of the rack's top, so it passes over the readouts on the rack's side, never under them; sampled (iso units).
 */
export function cablePoints(g: Gateway, r: Rack, n = 16): P2[] {
  const gx = Math.min(g.x1, Math.max(g.x0, r.x1)), a = iso(gx, (g.z0 + g.z1) / 2, g.h), b = iso((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, r.h);
  const lift = 0.25 * Math.hypot(b.x - a.x, b.y - a.y) + 2 * g.wu, c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
  return Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }; });
}
/** the cable crosses none of `obstacles` (the rack itself, where it ends, left out by the caller) but at its two ends */
const cableClear = (g: Gateway, r: Rack, obstacles: Box[]) => cablePoints(g, r).slice(2, -2).every((p) => !obstacles.some((o) => p.x > o.x0 && p.x < o.x1 && p.y > o.y0 && p.y < o.y1));

/**
 * A plate's sizes on the gateway's face (world units) at scale `k`: the port's number at 0.8 desk units, or 10 px if
 * that's more (so it reads at the whole map's zoom, while it fits its gate); the service under it only from 7 px up.
 */
export function plateSizes(g: Gateway, k: number): { num: number; service: number | null; h: number } {
  const room = (GATE.w - 0.6) * g.wu, num = Math.min(Math.max(0.8 * g.wu, 10 / k), room / (4 * 0.62));
  const svc = 0.55 * g.wu * k >= 7 ? 0.55 * g.wu : null;
  return { num, service: svc, h: num * 1.15 + (svc ? svc * 1.3 : 0) + 0.2 * g.wu };
}

/** what the fit takes in for the rack and the gateway (iso units at scale `k`) */
export const serverExtent = (r: Rack, g: Gateway, k: number): P2[] => {
  const b = gatewayBox(g, k);
  return [...rackExtent(r), { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }];
};

/** a rate as people read it: "340 B/s", "12 kB/s", "1.2 MB/s" (decimal units, as network rates are) */
export function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return "—";
  if (bps < 1000) return `${Math.round(bps)} B/s`;
  if (bps < 1e6) return `${bps < 1e4 ? (bps / 1e3).toFixed(1) : Math.round(bps / 1e3)} kB/s`;
  return `${bps < 1e7 ? (bps / 1e6).toFixed(1) : Math.round(bps / 1e6)} MB/s`;
}

/** a port's label: its number and service ("22 ssh", "443 https"), with "/udp" for UDP; the number alone without a name */
export const portLabel = (p: { port: number; proto: "tcp" | "udp"; service: string }) => `${p.port}${p.proto === "udp" ? "/udp" : ""}${p.service ? ` ${p.service}` : ""}`;

/** how fast a pulse runs along the cable for this much traffic (seconds; faster with more): 2.4 s idle … 0.5 s at 10 MB/s+ */
export const pulseSeconds = (bps: number) => Math.max(0.5, 2.4 - 0.48 * Math.max(0, Math.log10(Math.max(1, bps)) - 3));
