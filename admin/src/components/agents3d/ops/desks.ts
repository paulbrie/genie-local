/**
 * The agents' desks in the Ops view (T198, T201, T204c): on the isometric ground itself, each in front of the city
 * its agent works in (several at one city side by side along its front edge), seated facing the codebases, with room
 * enough in front of the city that the head and its bubble stay clear of the city's blocks on screen; and the
 * commits' conveyor belts (belt.ts), one per city along its far side, the top right on screen (T204). Pure: the
 * scale, the belts' strips, the seats, the points the map's fit must take in; and a desk's shapes in its own
 * isometric frame.
 */
import type { CityBounds } from "@/lib/city-layout";
import { iso, type P2 } from "./iso";

export type XZ = { x: number; z: number };
export type Belt = { repo: string; x0: number; x1: number; z0: number; z1: number; h: number };
export type DeskLine = {
  /** world units to a desk's own unit (the desk is 4.4 of them long, a seat's room 7) */
  wu: number;
  /** each city's belt (T204): along x from x0 to x1, across z from z0 (the far side) to z1 (the city's side), its top at h */
  belts: Belt[];
  /** what the map's fit must take in for the belts (screen units) */
  extent: P2[];
};

/** in a desk's own units: a belt's gap behind its city's far edge and its width; the least gap from the desks' far
 * edge (the monitors, at −3.6) to a city */
const BELT_GAP = 3.2, BELT_W = 1.8, TO_MAP = 1.2, DESK_FAR = 3.6;
/** a seat's room at most (world units): a desk about as long as a few files' blocks, its monitor a little over the tallest */
export const SEAT_MAX = 14;
/** the cafeteria table's radius (desk units) */
export const CAFE_R = 2.6;
/** the manager's row: at least this far (desk units) in front of the agents' desks */
const MANAGER_GAP = 10;

/** the desks' scale for `n` agents along `cities`, and each city's belt a gap behind its far edge */
export function deskLine(cities: CityBounds[], n: number): DeskLine {
  const x0 = cities.length ? Math.min(...cities.map((c) => c.x)) : 0;
  const x1 = cities.length ? Math.max(...cities.map((c) => c.x + c.w)) : 40;
  const len = Math.max(1, x1 - x0), wu = Math.min(SEAT_MAX, len / Math.max(n, 4)) / 7;
  const belts = cities.map((c) => ({ repo: c.repo, x0: c.x, x1: c.x + c.w, z0: c.z - (BELT_GAP + BELT_W) * wu, z1: c.z - BELT_GAP * wu, h: 0.9 * wu }));
  // (the fit takes in each belt's far side with its packages)
  const extent = belts.flatMap((b) => [iso(b.x0, b.z0, 3.5 * wu), iso(b.x1, b.z0, 3.5 * wu)]);
  return { wu, belts, extent };
}

export type DeskSpots = {
  /** each agent's seat on the ground (world units), by key (an agent at the cafeteria keeps its desk's) */
  seats: Map<string, XZ>;
  /** the cafeteria (T210): its round table's middle and radius, and each away agent's chair round it, facing it (yaw) */
  cafe: { x: number; z: number; r: number };
  cafeSeats: Map<string, XZ & { yaw: number }>;
  /** what the map's fit must take in for the desks, wherever their agents go (screen units) */
  extent: P2[];
};

/**
 * Each agent's seat (T204c): in front of its city (`city`, a repo; none, or a city not on the map: the lounge, left
 * of the leftmost city), the city's agents side by side along its front, centred on its middle, a seat's room apart,
 * in the agents' order. In front of the frontmost city edge over that stretch of x, by the desk's depth at least and
 * by twice `lift` (world units: the height over a seat that must stay clear of the city, the head and its bubble; in
 * this projection a point that high shows over the ground twice as far back).
 */
export function deskSpots(cities: CityBounds[], agents: { key: string; city?: string | null; manager?: boolean; away?: boolean }[], wu: number, lift: number): DeskSpots {
  const sp = 7 * wu, gap = Math.max((TO_MAP + DESK_FAR) * wu, 2 * lift);
  const byRepo = new Map(cities.map((c) => [c.repo, c]));
  const left = cities.length ? Math.min(...cities.map((c) => c.x)) : 0;
  // (the front edge over x0..x1: the frontmost city reaching into it, else the frontmost of all)
  const frontOver = (x0: number, x1: number) => {
    const over = cities.filter((c) => c.x < x1 && c.x + c.w > x0);
    return Math.max(...(over.length ? over : cities).map((c) => c.z + c.d), 0);
  };
  const groups = new Map<string, string[]>();
  for (const a of agents) {
    if (a.manager) continue;
    const k = a.city && byRepo.has(a.city) ? a.city : "";
    groups.set(k, [...(groups.get(k) ?? []), a.key]);
  }
  const seats = new Map<string, XZ>();
  for (const [repo, keys] of groups) {
    const c = byRepo.get(repo);
    // (a city's: centred on its middle; the lounge's: going left from the leftmost city)
    const mid = c ? c.x + c.w / 2 : left - sp * ((keys.length + 1) / 2);
    const x0 = mid - ((keys.length - 1) / 2) * sp - 2.2 * wu, x1 = mid + ((keys.length - 1) / 2) * sp + 2.2 * wu;
    const z = (c ? frontOver(x0, x1) : frontOver(left, left + sp)) + gap;
    keys.forEach((k, i) => seats.set(k, { x: mid + (i - (keys.length - 1) / 2) * sp, z }));
  }
  // (the fit: every city's desk band, and the lounge's, so the view doesn't change when an agent moves)
  const band = (x0: number, x1: number) => { const z = frontOver(x0, x1) + gap; return [iso(x0, z + 2.5 * wu), iso(x1, z + 2.5 * wu), iso(x0, z - 3.6 * wu, 6 * wu), iso(x1, z - 3.6 * wu, 6 * wu)]; };
  const extent = [...cities.flatMap((c) => band(c.x, c.x + c.w)), ...(groups.has("") ? band(left - sp * (groups.get("")!.length + 0.5), left) : [])];
  // (the cafeteria, T210: a round table near the front, in the manager's row at the cities' left end, clear of the
  // desks; its chairs from the far side round, so the faces of the first few show)
  const r = CAFE_R * wu, frontAll = Math.max(...cities.map((c) => frontOver(c.x, c.x + c.w) + gap), 0);
  const cafe = { x: left + r + 2 * wu, z: frontAll + Math.max(MANAGER_GAP * wu, gap), r };
  const away = agents.filter((a) => a.away && !a.manager);
  const step = Math.min((2 * Math.PI) / Math.max(1, away.length), 0.95);
  const cafeSeats = new Map(away.map((a, i) => {
    const yaw = Math.PI + (i - (away.length - 1) / 2) * step, d = r + 1.2 * wu;
    return [a.key, { x: cafe.x + d * Math.sin(yaw), z: cafe.z + d * Math.cos(yaw), yaw }];
  }));
  extent.push(iso(cafe.x - r - 3 * wu, cafe.z + r + 3 * wu), iso(cafe.x + r + 3 * wu, cafe.z - r - 3 * wu, 6 * wu), iso(cafe.x - r - 3 * wu, cafe.z - r - 3 * wu, 6 * wu));
  // (the manager, T204e: a row of its own in front of every desk, centred on the cities; as far out again as the
  // bubbles need, so its own and the agents' don't meet)
  const boss = agents.find((a) => a.manager);
  if (boss) {
    const right = cities.length ? Math.max(...cities.map((c) => c.x + c.w)) : 40;
    const front = Math.max(...cities.map((c) => frontOver(c.x, c.x + c.w) + gap), 0);
    const seat = { x: (left + right) / 2, z: front + Math.max(MANAGER_GAP * wu, gap) };
    seats.set(boss.key, seat);
    extent.push(iso(seat.x - sp, seat.z + 3.5 * wu), iso(seat.x + sp, seat.z + 3.5 * wu));
  }
  return { seats, extent, cafe, cafeSeats };
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
