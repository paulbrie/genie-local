/**
 * The Table's touched buildings (T108): each building's lift this frame, from
 * the seated agents' file touches and the edits seen through file mtimes, with
 * Alex's shared curve (lib/lift.ts). Pure, so the rules are tested.
 */
import { fileKey, lastBefore, type Timeline, type TLAgent, toolKind } from "@/lib/agents3d-timeline";
import { LIFT_STOREYS, liftActive, liftAt, TOUCH_HOLD_MS, type TouchKind } from "@/lib/lift";

/** A storey of the mini-cities, in world units (an edit lifts 1.5 of them, a read 1). */
export const STOREY = 0.45;

/**
 * Writes each building's lift (world units, by layout index) into `out` and
 * says whether any is still moving or held. Several touches of one file: the
 * highest lift (a new touch while it's up keeps it up). `ageOf(ms)`: real ms
 * since a timeline moment. Reduced motion: full height while a touch lasts, no easing.
 */
export function liftsAt(
  out: Float32Array,
  index: Map<string, number>,
  cast: Pick<TLAgent, "events">[],
  edits: Timeline["edits"],
  t: number,
  ageOf: (ms: number) => number,
  linger: number,
  reduced: boolean,
): boolean {
  out.fill(0);
  let lifting = false;
  const lift = (fk: string, kind: TouchKind, age: number) => {
    const bi = index.get(fk);
    if (bi === undefined || bi >= out.length || !liftActive(age, linger)) return;
    lifting = true;
    const h = (reduced ? LIFT_STOREYS[kind] : liftAt(kind, age, linger)) * STOREY;
    if (h > out[bi]) out[bi] = h;
  };
  // Touches older than this have settled (lists are time-sorted: stop there).
  const span = TOUCH_HOLD_MS + linger + 1000;
  for (const a of cast)
    for (let j = lastBefore(a.events, t); j >= 0; j--) {
      const e = a.events[j];
      const age = ageOf(e.ms);
      if (age > span) break;
      const kind = toolKind(e.tool);
      if (e.repo && e.path && (kind === "edit" || kind === "read")) lift(fileKey(e.repo, e.path), kind, age);
    }
  for (let j = lastBefore(edits, t); j >= 0; j--) {
    const age = ageOf(edits[j].ms);
    if (age > span) break;
    lift(edits[j].fileKey, "edit", age);
  }
  return lifting;
}
