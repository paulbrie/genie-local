/**
 * Alice shelves the commits (T95): on a new commit (live) she stands up, steps
 * out between the chairs, walks round the free ring to the bookshelf with the
 * book, puts it in place, walks back and sits down. Commits that come together
 * go in one trip; ones that come during a trip wait for the next. Without a
 * walker at the table a new book just appears (with a small settle). Pure,
 * with an explicit clock, so the path and the triggers are tested.
 */
import { AVATAR_SCALE, type Seat, SHELF_STAND, WALK, type XZ } from "./world";

/** Walking speed (world units/s): a brisk walk. */
export const WALK_SPEED = 9;
/** applyPose's walk cycle covers this much ground per second of its time: walking `d` units, give it d / STRIDE_V seconds and the feet don't slide. */
export const STRIDE_V = 5.2;
export const STAND_MS = 600;
export const PLACE_MS = 1200;
export const SIT_MS = 600;
/** In the place phase, the books reach the shelf at this share of it. */
const PLACED_AT = 0.6;
/** A book that appears without a walk settles from this high, over SETTLE_MS. */
export const SETTLE_H = 0.5;
export const SETTLE_MS = 400;

const angleOf = (p: XZ) => Math.atan2(p.x, -p.z);
const polar = (phi: number, r: number): XZ => ({ x: r * Math.sin(phi), z: -r * Math.cos(phi) });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The way from a seat to the shelf: a step sideways (towards the shelf) to clear
 * the chair, out to the middle of the walking ring, round it, then straight to
 * the spot in front of the shelf.
 */
export function shelfPath(seat: Seat): XZ[] {
  const phiSeat = angleOf(seat);
  const phiShelf = angleOf(SHELF_STAND);
  const turn = wrap(phiShelf - phiSeat);
  const dir = turn >= 0 ? 1 : -1;
  // The tangent at the seat, towards increasing angle, is (cos φ, sin φ).
  const side = AVATAR_SCALE * 0.7;
  const p1 = { x: seat.x + dir * Math.cos(phiSeat) * side, z: seat.z + dir * Math.sin(phiSeat) * side };
  const r = (WALK.r0 + WALK.r1) / 2;
  const from = angleOf(p1);
  const span = wrap(phiShelf - from);
  const steps = Math.max(1, Math.ceil(Math.abs(span) / 0.12));
  const ring = Array.from({ length: steps + 1 }, (_, i) => polar(from + (span * i) / steps, r));
  return [{ x: seat.x, z: seat.z }, p1, ...ring, { x: SHELF_STAND.x, z: SHELF_STAND.z }];
}

export type Trip = {
  start: number;
  books: string[];
  seat: Seat;
  pts: XZ[];
  /** Distance along the path at each point. */
  cum: number[];
  len: number;
};

export function makeTrip(seat: Seat, books: string[], start: number): Trip {
  const pts = shelfPath(seat);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { start, books, seat, pts, cum, len: cum[cum.length - 1] };
}

const walkMs = (t: Trip) => (t.len / WALK_SPEED) * 1000;
export const tripMs = (t: Trip) => STAND_MS + 2 * walkMs(t) + PLACE_MS + SIT_MS;

export type TripPose = {
  phase: "stand" | "out" | "place" | "back" | "sit";
  x: number;
  z: number;
  /** Facing (rotation about y; the avatar faces +z at 0). */
  yaw: number;
  /** Progress through the phase, 0..1. */
  k: number;
  /** Ground covered so far (for the walk cycle: d / STRIDE_V seconds). */
  walked: number;
  /** Walking right now. */
  moving: boolean;
  /** Still holding the books (until they're on the shelf). */
  carrying: boolean;
};

/** Where along the path, distance `d` from the seat: the point and the way it faces going outwards. */
function along(t: Trip, d: number): { x: number; z: number; yaw: number } {
  const dd = Math.max(0, Math.min(t.len, d));
  let i = 1;
  while (i < t.cum.length - 1 && t.cum[i] < dd) i++;
  const a = t.pts[i - 1];
  const b = t.pts[i];
  const seg = t.cum[i] - t.cum[i - 1] || 1;
  const f = (dd - t.cum[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
}

/** The walker's pose at `now` during a trip, or null once it's over (back in the seat). */
export function tripAt(t: Trip, now: number): TripPose | null {
  let ms = now - t.start;
  const w = walkMs(t);
  if (ms < 0) return null;
  if (ms < STAND_MS) return { phase: "stand", x: t.seat.x, z: t.seat.z, yaw: t.seat.yaw, k: ms / STAND_MS, walked: 0, moving: false, carrying: true };
  ms -= STAND_MS;
  if (ms < w) {
    const d = (ms / w) * t.len;
    const p = along(t, d);
    return { phase: "out", x: p.x, z: p.z, yaw: p.yaw, k: ms / w, walked: d, moving: true, carrying: true };
  }
  ms -= w;
  const end = t.pts[t.pts.length - 1];
  if (ms < PLACE_MS) {
    const k = ms / PLACE_MS;
    // Facing the shelf (it's behind the spot, towards -z).
    return { phase: "place", x: end.x, z: end.z, yaw: Math.PI, k, walked: t.len, moving: false, carrying: k < PLACED_AT };
  }
  ms -= PLACE_MS;
  if (ms < w) {
    const d = t.len - (ms / w) * t.len;
    const p = along(t, d);
    return { phase: "back", x: p.x, z: p.z, yaw: p.yaw + Math.PI, k: ms / w, walked: t.len + (t.len - d), moving: true, carrying: false };
  }
  ms -= w;
  if (ms < SIT_MS) return { phase: "sit", x: t.seat.x, z: t.seat.z, yaw: t.seat.yaw, k: smooth(ms / SIT_MS), walked: 2 * t.len, moving: false, carrying: false };
  return null;
}

/** Who shelves the commits: the manager at the table (Alice), else whoever is named Alice; -1 for nobody. */
export function walkerOf(cast: { name: string; role: string }[]): number {
  const m = cast.findIndex((a) => a.role === "manager");
  return m >= 0 ? m : cast.findIndex((a) => a.name.toLowerCase() === "alice");
}

/**
 * The shelving's state over frames: which commits are known, which wait for a
 * trip, the trip under way, and books settling in on their own.
 */
export class ShelfRun {
  private known = new Set<string>();
  private primed = false;
  pending: string[] = [];
  trip: Trip | null = null;
  /** Books that appeared without a walk: hash → when (for the settle). */
  settling = new Map<string, number>();

  /**
   * One frame: `hashes` are the commits shown (oldest first), `walker` the seat
   * of who shelves them (null: nobody at the table). In replay nothing walks:
   * the books are as of the scrubber's time, and going live again starts afresh.
   */
  update(hashes: string[], now: number, live: boolean, walker: Seat | null) {
    if (!live || !this.primed) {
      this.known = new Set(hashes);
      this.pending = [];
      this.trip = null;
      this.settling.clear();
      this.primed = live;
      return;
    }
    for (const h of hashes) {
      if (this.known.has(h)) continue;
      this.known.add(h);
      if (walker) this.pending.push(h);
      else this.settling.set(h, now);
    }
    if (this.trip && (!walker || !tripAt(this.trip, now))) {
      // Done, or the walker left the table mid-way: whatever it carried lands now.
      if (!walker && !this.placed(now)) for (const h of this.trip.books) this.settling.set(h, now);
      this.trip = null;
    }
    if (!this.trip && this.pending.length && walker) {
      this.trip = makeTrip(walker, this.pending, now);
      this.pending = [];
    }
    if (!walker && this.pending.length) {
      for (const h of this.pending) this.settling.set(h, now);
      this.pending = [];
    }
    for (const [h, at] of this.settling) if (now - at > SETTLE_MS) this.settling.delete(h);
  }

  /** The trip's books are on the shelf. */
  private placed(now: number): boolean {
    const p = this.trip && tripAt(this.trip, now);
    return !p || !p.carrying;
  }

  /** Books not on the shelf yet: waiting for a trip, or being carried. */
  hidden(now: number): Set<string> {
    const out = new Set(this.pending);
    if (this.trip && !this.placed(now)) for (const h of this.trip.books) out.add(h);
    return out;
  }

  /** A settling book's height above its place (0 once settled). */
  settle(hash: string, now: number): number {
    const at = this.settling.get(hash);
    if (at === undefined) return 0;
    const k = Math.min(1, (now - at) / SETTLE_MS);
    return SETTLE_H * (1 - k) * (1 - k);
  }

  /** Anything moving: a trip, or a book settling (ask for frames). */
  busy(now: number): boolean {
    return (this.trip !== null && tripAt(this.trip, now) !== null) || this.settling.size > 0;
  }
}
