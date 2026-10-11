/**
 * The agents' desks in the Ops view (T198, T201): on the isometric ground itself, in a row along the map's front
 * edge (a line parallel to the cities' edges: the cities lie along x, so the row does too, in front of them), one desk
 * and computer per agent, each agent seated facing the codebases; behind them, between the desks and the cities, the
 * commits' conveyor belt (belt.ts). Pure: the row's seats and scale in world units, the belt's strip, the points the
 * map's fit must take in; and a desk's shapes in its own isometric frame.
 */
import type { CityBounds } from "@/lib/city-layout";
import { iso, type P2 } from "./iso";

export type XZ = { x: number; z: number };
export type DeskLine = {
  /** each agent's seat on the ground (world units), in the agents' order */
  seats: XZ[];
  /** world units to a desk's own unit (the desk is 4.4 of them long) */
  wu: number;
  /** the belt: along x from x0 to x1, across z from z0 (the cities' side) to z1, its top at h */
  belt: { x0: number; x1: number; z0: number; z1: number; h: number };
  /** what the map's fit must take in besides the cities (screen units) */
  extent: P2[];
};

/** in a desk's own units: the belt behind the seat (towards the cities), and the gap to the cities */
const BELT_NEAR = 4.6, BELT_FAR = 6.4, TO_MAP = 1.6;
/** a seat's room at most (world units): a desk about as long as a few files' blocks, its monitor a little over the tallest */
export const SEAT_MAX = 14;

/**
 * The row for `n` agents in front of `cities`: seats spaced evenly along x, centred on the cities, a seat's room a
 * seventh of its spacing to a desk unit; spacing at most SEAT_MAX, and a quarter of the cities' length (a short team
 * keeps together). The belt runs the cities' length, a little past each end.
 */
export function deskLine(cities: CityBounds[], n: number): DeskLine {
  const x0 = cities.length ? Math.min(...cities.map((c) => c.x)) : 0;
  const x1 = cities.length ? Math.max(...cities.map((c) => c.x + c.w)) : 40;
  const front = cities.length ? Math.max(...cities.map((c) => c.z + c.d)) : 0;
  const len = Math.max(1, x1 - x0), sp = Math.min(SEAT_MAX, len / Math.max(n, 4)), wu = sp / 7;
  const z = front + (TO_MAP + BELT_FAR) * wu, mid = (x0 + x1) / 2;
  const seats = Array.from({ length: n }, (_, i) => ({ x: mid + (i - (n - 1) / 2) * sp, z }));
  const belt = { x0: x0 - 2 * wu, x1: x1 + 2 * wu, z0: z - BELT_FAR * wu, z1: z - BELT_NEAR * wu, h: 0.9 * wu };
  const near = z + 3 * wu;
  const extent = [iso(belt.x0, belt.z0, 6 * wu), iso(belt.x1, belt.z0, 6 * wu), iso(belt.x0, near), iso(belt.x1, near)];
  return { seats, wu, belt, extent };
}

/** a desk unit in pixels at full sprite scale (desk-sprites draws with `u` = wu × fit's k ÷ L) */
// A desk in its own isometric frame: x along the desk (to the lower right on screen), z towards the agent (to the
// lower left), h up; `L` units to pixels at full scale. The same axes as the map's, so a desk lies on its ground.
const C = Math.cos(Math.PI / 6);
export const L = 9.5;
export const local = (x: number, z: number, h: number, u = 1): P2 => ({ x: (x - z) * C * L * u, y: ((x + z) * 0.5 - h) * L * u });

/** a box's three visible faces (top; the face towards +z, lower left; the face towards +x, lower right) */
export function boxFaces(x0: number, x1: number, z0: number, z1: number, h0: number, h1: number, u = 1) {
  const p = (x: number, z: number, h: number) => local(x, z, h, u);
  return {
    top: [p(x0, z0, h1), p(x1, z0, h1), p(x1, z1, h1), p(x0, z1, h1)],
    front: [p(x0, z1, h1), p(x1, z1, h1), p(x1, z1, h0), p(x0, z1, h0)],
    side: [p(x1, z0, h1), p(x1, z1, h1), p(x1, z1, h0), p(x1, z0, h0)],
  };
}

/**
 * The desk's parts, the seat (where the agent sits) at the origin: the desktop in front of it (towards −z, the map),
 * the monitor at the desktop's far edge, its screen facing the agent (so seen over the agent's shoulder).
 */
export function deskParts(u = 1) {
  // (a desktop on two side panels, open underneath)
  const top = boxFaces(-2.2, 2.2, -3.6, -1.4, 2.35, 2.6, u);
  const legL = boxFaces(-2.1, -1.9, -3.5, -1.5, 0, 2.35, u), legR = boxFaces(1.9, 2.1, -3.5, -1.5, 0, 2.35, u);
  const monitor = boxFaces(-1.3, 1.3, -3.3, -3.0, 2.9, 5.2, u);
  // (the screen: the monitor's face towards the agent, inset)
  const screen = [local(-1.1, -3.0, 5.0, u), local(1.1, -3.0, 5.0, u), local(1.1, -3.0, 3.1, u), local(-1.1, -3.0, 3.1, u)];
  const stand = boxFaces(-0.2, 0.2, -3.25, -3.05, 2.6, 2.9, u);
  // (where a beam to the agent's file leaves: the monitor's top middle)
  const beam = local(0, -3.15, 5.2, u);
  return { top, legL, legR, monitor, screen, stand, beam };
}

export const pts = (ps: P2[], at: P2 = { x: 0, y: 0 }) => ps.map((p) => `${(at.x + p.x).toFixed(1)},${(at.y + p.y).toFixed(1)}`).join(" ");
