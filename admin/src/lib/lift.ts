/**
 * A touched file's building lifts off its plot (Agents City and the Table's
 * mini-cities): eased up over LIFT_RISE_MS, held while the touch lasts (the
 * lightning's hold plus its linger), then eased back down over
 * LIFT_SETTLE_MS. An edit lifts higher than a read. Pure: each scene scales
 * the result to its own storey.
 *
 * Several touches of one file: take the highest lift over them (`max`), so a
 * new touch while the building is up keeps it up instead of bouncing.
 */

/** A touched file keeps its bolt (and its lift) this long, real ms, before the linger starts. */
export const TOUCH_HOLD_MS = 6000;
export const LIFT_RISE_MS = 300;
export const LIFT_SETTLE_MS = 600;
/** Lift in storeys by kind of touch. */
export const LIFT_STOREYS = { edit: 1.5, read: 1 } as const;

export type TouchKind = keyof typeof LIFT_STOREYS;

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The lift in storeys of one touch `ageMs` (real) ms ago, with the lightning's
 * `lingerMs`; 0 before the touch and once settled.
 */
export function liftAt(kind: TouchKind, ageMs: number, lingerMs: number): number {
  if (ageMs < 0) return 0;
  const hold = TOUCH_HOLD_MS + Math.max(0, lingerMs);
  const k = ageMs < LIFT_RISE_MS ? smooth(ageMs / LIFT_RISE_MS) : ageMs <= hold ? 1 : 1 - smooth((ageMs - hold) / LIFT_SETTLE_MS);
  return LIFT_STOREYS[kind] * k;
}

/** Whether a touch `ageMs` ago still lifts its building (for asking frames: rising, held or settling). */
export function liftActive(ageMs: number, lingerMs: number): boolean {
  return ageMs >= 0 && ageMs < TOUCH_HOLD_MS + Math.max(0, lingerMs) + LIFT_SETTLE_MS;
}
