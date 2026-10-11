/**
 * The commits' conveyor belt in the Ops view (T201): along the cities' far side, the top right on screen, behind them
 * (T204). Each commit is a package; a new one drops onto the belt beside the city of the repo it went into (or at the
 * belt's far end, a repo not on the map), where it waits in that repo's queue, the newest at the front. Pure: where each package rests along the belt (world x), packages never closer
 * than a slot, all on the belt.
 */
import type { CityBounds } from "@/lib/city-layout";
import type { DeskLine } from "./desks";
import type { OpsCommit } from "./model";

/** a package's side, and a slot (a package and the gap to the next), in a desk's units */
export const PKG = 1.3, SLOT = 1.7;

/**
 * Each commit's resting place along the belt (world x), by hash: each repo's packages queue back from its city's
 * middle (the newest there), the rest at the far end; then any two closer than a slot pushed apart, and the lot
 * kept on the belt (squeezed if they don't fit).
 */
export function beltPlaces(commits: OpsCommit[], cities: CityBounds[], line: DeskLine): Map<string, number> {
  const { x0, x1 } = line.belt, half = (PKG * line.wu) / 2;
  const lo = x0 + half, hi = x1 - half;
  const slot = Math.min(SLOT * line.wu, commits.length > 1 ? (hi - lo) / (commits.length - 1) : Infinity);
  const head = new Map(cities.map((c) => [c.repo, c.x + c.w / 2]));
  // (newest first within each repo: the newest at the head, the older ones behind it)
  const k = new Map<string, number>();
  const want = [...commits].reverse().map((c) => {
    const key = c.repo !== null && head.has(c.repo) ? c.repo : "";
    const n = k.get(key) ?? 0;
    k.set(key, n + 1);
    return { hash: c.hash, x: (key ? head.get(key)! : hi) - n * slot };
  });
  want.sort((a, b) => a.x - b.x || a.hash.localeCompare(b.hash));
  const xs = want.map((w) => w.x);
  for (let i = 0; i < xs.length; i++) xs[i] = Math.max(xs[i], i ? xs[i - 1] + slot : lo);
  for (let i = xs.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i < xs.length - 1 ? xs[i + 1] - slot : hi);
  return new Map(want.map((w, i) => [w.hash, Math.max(lo, xs[i])]));
}
