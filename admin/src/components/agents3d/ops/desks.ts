/**
 * The agents' desks in the Ops view (T198): a row along the front of the isometric map, before the repos, one desk
 * and computer per agent, each agent seated at it facing the codebases. In isometric view a line of equal depth
 * (x + z) runs straight across the screen, so the row is a horizontal line under the map: every desk equally near.
 * Pure: the row's places and scale, and a desk's shapes in its own isometric frame (pixels, its seat at 0,0).
 */
import type { P2 } from "./iso";

/** the row's height at full scale (px): the monitor over the desk, the seated agent, its name under it */
export const ROW_H = 132;
/** one desk's width at full scale (px), and the least room between two */
const DESK_W = 92, GAP = 14;
/** the scale a crowded row shrinks to, at most */
const MIN_U = 0.55;

export type DeskRow = {
  /** each desk's seat (px, in the map's box), in the agents' order */
  seats: P2[];
  /** the sprites' scale (1 = full size) */
  u: number;
};

/**
 * The row for `n` agents in a box `w` × `h` (px): centred across, on a line `bottom` px over the box's foot; desks
 * spaced evenly, no wider apart than a desk and a half, and shrunk (to MIN_U) when they don't fit at full size.
 */
export function deskRow(n: number, w: number, h: number, bottom = 22): DeskRow {
  if (n <= 0 || w <= 0) return { seats: [], u: 1 };
  const room = w - 24;
  const u = Math.max(MIN_U, Math.min(1, room / (n * (DESK_W + GAP))));
  const step = Math.min((DESK_W + GAP) * u * 1.5, room / n);
  // (a desk stands to the upper right of its seat: the row centred on the desks, not the seats)
  const x0 = w / 2 - (step * (n - 1)) / 2 - 18 * u;
  const y = h - bottom - 36 * u;
  return { seats: Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, y })), u };
}

/** the room the row takes under the map (px), at its scale */
export const rowRoom = (u: number) => ROW_H * u + 22;

// A desk in its own isometric frame: x along the desk (to the lower right on screen), z towards the agent (to the
// lower left), h up; `L` units to pixels at full scale.
const C = Math.cos(Math.PI / 6), L = 9.5;
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
