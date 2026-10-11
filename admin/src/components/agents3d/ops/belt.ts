/**
 * The commits' conveyor belts in the Ops view (T201, T204): one per city, along its far side (the top right on screen,
 * behind it), carrying that repo's commits. Each commit is a package; a new one drops onto its repo's belt, where it
 * waits in the queue, the newest nearest the city's middle. A repo with no city on the map has no belt: its commits
 * aren't shown there (nothing on the map to deliver them to). Pure: where each package rests (world x, on which belt),
 * never two closer than a slot, all on their belt; a full belt keeps its newest.
 */
import type { Belt, DeskLine } from "./desks";
import type { OpsCommit } from "./model";

/** a package's side, and a slot (a package and the gap to the next), in a desk's units */
export const PKG = 1.3, SLOT = 1.7;

/** each placed commit's belt and world x, by hash */
export function beltPlaces(commits: OpsCommit[], line: DeskLine): Map<string, { belt: Belt; x: number }> {
  const out = new Map<string, { belt: Belt; x: number }>();
  const half = (PKG * line.wu) / 2, slot = SLOT * line.wu;
  for (const b of line.belts) {
    const lo = b.x0 + half, hi = b.x1 - half;
    if (hi < lo) continue;
    // (the newest first, as many as the belt holds; each one a slot further back from the middle)
    const fit = Math.floor((hi - lo) / slot) + 1;
    const mine = commits.filter((c) => c.repo === b.repo).reverse().slice(0, fit);
    const mid = (b.x0 + b.x1) / 2;
    const want = mine.map((c, k) => ({ hash: c.hash, x: mid - k * slot }));
    want.sort((p, q) => p.x - q.x);
    const xs = want.map((w) => w.x);
    for (let i = 0; i < xs.length; i++) xs[i] = Math.max(xs[i], i ? xs[i - 1] + slot : lo);
    for (let i = xs.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i < xs.length - 1 ? xs[i + 1] - slot : hi);
    want.forEach((w, i) => out.set(w.hash, { belt: b, x: Math.max(lo, xs[i]) }));
  }
  return out;
}
