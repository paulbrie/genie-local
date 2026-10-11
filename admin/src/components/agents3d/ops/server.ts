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

/** what the fit takes in for the rack: its top, and its label over it (screen units) */
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
