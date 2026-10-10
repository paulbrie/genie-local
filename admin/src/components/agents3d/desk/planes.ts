/**
 * Messages between agents as paper planes (T106): each leaves the sender's
 * hands, flies a gentle arc (a little bank and bob, not a straight line) to the
 * receiver and lands at their seat, where it unfolds into a note and is gone;
 * one to someone not at the table flies off the table's edge. Several from one
 * sender at once go one after another. Pure, so the flight is tested.
 */

/** A flight's length (real ms), the unfolding after it, and the gap between planes from one sender. */
export const FLIGHT_MS = 2200;
export const UNFOLD_MS = 500;
export const STAGGER_MS = 350;

export type P3 = { x: number; y: number; z: number };

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** How high the arc rises over the straight line at its middle. */
export const arcHeight = (from: P3, to: P3) => 1.2 + Math.hypot(to.x - from.x, to.z - from.z) * 0.12;

/** A plane's place and attitude: position, heading (yaw), nose up/down (pitch) and bank (roll). */
export type PlanePose = P3 & { yaw: number; pitch: number; roll: number };

/**
 * The plane `k` (0..1) of the way from `from` to `to`: eased along the ground,
 * an arc above the straight line, a slow bob, and a gentle bank that sways
 * side to side and fades out as it lands. `seed` varies the sway per plane.
 */
export function planeAt(from: P3, to: P3, k: number, seed = 0, out: PlanePose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }): PlanePose {
  const u = smooth(k);
  const h = arcHeight(from, to);
  const bob = Math.sin(k * Math.PI * 4 + seed) * 0.12 * Math.sin(Math.PI * k);
  out.x = from.x + (to.x - from.x) * u;
  out.z = from.z + (to.z - from.z) * u;
  out.y = from.y + (to.y - from.y) * u + h * Math.sin(Math.PI * k) + bob;
  out.yaw = Math.atan2(to.x - from.x, to.z - from.z);
  // The arc's slope (dy/dground), nosing up on the climb and down to land.
  const ground = Math.max(0.01, Math.hypot(to.x - from.x, to.z - from.z));
  out.pitch = -Math.atan2((to.y - from.y + h * Math.PI * Math.cos(Math.PI * k)) / Math.max(0.2, 6 * u * (1 - u) + 0.2), ground) * 0.5;
  out.roll = Math.sin(k * Math.PI * 2 + seed) * 0.35 * (1 - k);
  return out;
}

export type Flight = { id: string; from: string; to: string; start: number };

/**
 * When each message's plane takes off: when it's due (`at`), or after the one
 * before it from the same sender plus STAGGER_MS, so several at once leave one
 * after another. `msgs` in any order; the result is by id.
 */
export function stagger(msgs: { id: string; from: string; at: number }[], gap = STAGGER_MS): Map<string, number> {
  const out = new Map<string, number>();
  const last = new Map<string, number>();
  for (const m of [...msgs].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const prev = last.get(m.from);
    const start = prev !== undefined && m.at < prev + gap ? prev + gap : m.at;
    out.set(m.id, start);
    last.set(m.from, start);
  }
  return out;
}

/**
 * A flight's state `age` (real ms) after take-off: flying (k), unfolding at the
 * end (u: 0 folded .. 1 gone), or not shown (before take-off or done).
 */
export function flightState(age: number): { phase: "fly"; k: number } | { phase: "unfold"; u: number } | null {
  if (age < 0) return null;
  if (age < FLIGHT_MS) return { phase: "fly", k: age / FLIGHT_MS };
  if (age < FLIGHT_MS + UNFOLD_MS) return { phase: "unfold", u: (age - FLIGHT_MS) / UNFOLD_MS };
  return null;
}

/** Where a plane to someone not at the table goes: off the table's edge, on the far side from its sender, falling away. */
export function offTable(from: P3, tableR: number, floorY: number): P3 {
  const r = Math.hypot(from.x, from.z) || 1;
  return { x: (-from.x / r) * (tableR + 6), y: floorY + 1, z: (-from.z / r) * (tableR + 6) };
}
