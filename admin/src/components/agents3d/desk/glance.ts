/**
 * Where a thinking agent's eyes look (T93): quick glances, held a while, the
 * way a person's eyes wander while thinking. Mostly up-left and up-right,
 * sometimes to the side or down, now and then back to the centre; a blink with
 * some glances; after a long hold the head follows a little. Pure and
 * repeatable: seeded by the agent and the wall-clock slot, so live and replay
 * look alike and no two agents move in step.
 */

/** A glance (the eyes' move) takes 80–120 ms. */
const MOVE_MS = { min: 80, max: 120 };
/** Then the eyes hold for 0.6–2.5 s. */
const HOLD_MS = { min: 600, max: 2500 };
/** A blink with this share of the glances, this long. */
const BLINK_SHARE = 0.25;
const BLINK_MS = 120;
/** Holds longer than this let the head follow: from HEAD_AFTER_MS into the hold, eased over HEAD_EASE_MS, by HEAD_SHARE of the gaze. */
const HEAD_FOLLOW_MS = 1500;
const HEAD_AFTER_MS = 500;
const HEAD_EASE_MS = 400;
export const HEAD_SHARE = 0.3;
/** Fixations are laid out per wall-clock slot of this length; a slot's first glance starts it. */
export const SLOT_MS = 20_000;

/** Where the eyes can go (x: right +, y: up +; -1..1 of their range) and how often. */
const SPOTS: { x: number; y: number; w: number }[] = [
  { x: -0.8, y: 0.7, w: 32 }, // up-left
  { x: 0.8, y: 0.7, w: 32 }, // up-right
  { x: -1, y: 0, w: 8 }, // left
  { x: 1, y: 0, w: 8 }, // right
  { x: 0, y: -0.7, w: 8 }, // down
  { x: 0, y: 0, w: 12 }, // back to the centre
];
const TOTAL_W = SPOTS.reduce((n, s) => n + s.w, 0);

/** A repeatable 0–1 from a seed and two counters. */
function rand(seed: number, a: number, b: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

type Fix = { start: number; move: number; hold: number; x: number; y: number; blink: boolean };

/** The n-th fixation of a slot: when its glance starts, how long it moves and holds, where to, and whether it blinks. */
function fixation(seed: number, slot: number, n: number, start: number): Fix {
  const move = MOVE_MS.min + (MOVE_MS.max - MOVE_MS.min) * rand(seed, slot, n * 4);
  const hold = HOLD_MS.min + (HOLD_MS.max - HOLD_MS.min) * rand(seed, slot, n * 4 + 1);
  let pick = rand(seed, slot, n * 4 + 2) * TOTAL_W;
  const spot = SPOTS.find((s) => (pick -= s.w) < 0) ?? SPOTS[SPOTS.length - 1];
  return { start, move, hold, x: spot.x, y: spot.y, blink: rand(seed, slot, n * 4 + 3) < BLINK_SHARE };
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export type Glance = {
  /** The eyes' offset, -1..1 of their range (x right, y up). */
  x: number;
  y: number;
  /** The head's share of the gaze, 0..HEAD_SHARE (turn it by that share of the eyes' direction). */
  head: number;
  /** The head's target direction while it follows (the held gaze). */
  hx: number;
  hy: number;
  blink: boolean;
  /** Something is moving (a glance, a blink, the head easing): ask for frames. */
  moving: boolean;
  /** Real ms until the next movement starts, when still. */
  inMs: number;
};

/** The eyes of agent `seed` at wall-clock `now` (ms) while thinking. */
export function glanceAt(seed: number, now: number): Glance {
  const slot = Math.floor(now / SLOT_MS);
  const slotStart = slot * SLOT_MS;
  // Walk the slot's fixations up to now; the previous one's spot is where the glance comes from.
  let prev = { x: 0, y: 0 };
  let f = fixation(seed, slot, 0, slotStart);
  for (let n = 1; f.start + f.move + f.hold <= now; n++) {
    prev = f;
    f = fixation(seed, slot, n, f.start + f.move + f.hold);
  }
  const into = now - f.start;
  const k = ease(into / f.move);
  const x = prev.x + (f.x - prev.x) * k;
  const y = prev.y + (f.y - prev.y) * k;
  const blink = f.blink && into < BLINK_MS;
  const follows = f.hold > HEAD_FOLLOW_MS && (f.x !== 0 || f.y !== 0);
  const headT = into - f.move - HEAD_AFTER_MS;
  const head = follows ? HEAD_SHARE * ease(headT / HEAD_EASE_MS) : 0;
  const glancing = into < Math.max(f.move, f.blink ? BLINK_MS : 0);
  const easingHead = follows && headT > 0 && headT < HEAD_EASE_MS;
  const moving = glancing || easingHead;
  // Still: until the head starts to follow, or the next glance (or the next slot's first), whichever comes first.
  const next = Math.min(f.start + f.move + f.hold, slotStart + SLOT_MS, follows && headT <= 0 ? f.start + f.move + HEAD_AFTER_MS : Infinity);
  return { x, y, head, hx: f.x, hy: f.y, blink, moving, inMs: moving ? 0 : Math.max(0, next - now) };
}
