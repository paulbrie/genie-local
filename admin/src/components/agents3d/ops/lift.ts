/**
 * Files being worked on, lifted into the air (T216): a file edited or read in the last 90 s (the curves' set, model
 * links) rises off its city, an edit higher than a read, so it stands clear of the roofs round it; its spot keeps a
 * soft shadow. Pure: which files rise and how high, a block moved up, its shadow on the ground, and which lifted
 * block is under a point (for hover and the menus), front-most first.
 */
import type { Belt } from "./desks";
import type { IsoBlock, IsoMap, P2 } from "./iso";
import { inPoly, iso } from "./iso";
import type { OpsLink } from "./model";
import { boxOf, overlap, type Box } from "./server";

/** how high a file's block rises (the map's units; the tallest roof is 4.2): an edit higher than a read */
export const LIFT = { edit: 14, read: 9 } as const;
export type Lift = { h: number; kind: "edit" | "read"; /** its name under it rather than over it (no room over it, by a belt) */ nameBelow?: boolean };

/** the files that rise, by key: edited or read lately by anyone (an edit over a read); claimed only: none */
export function liftsOf(links: OpsLink[]): Map<string, Lift> {
  const out = new Map<string, Lift>();
  for (const l of links) {
    if (l.kind === "claim" || l.fade <= 0) continue;
    if (out.get(l.file)?.kind === "edit") continue;
    out.set(l.file, { h: LIFT[l.kind], kind: l.kind });
  }
  return out;
}
/** the lifts as a short key: the same key, nothing to draw again */
export const liftsKey = (m: Map<string, Lift>) => [...m].map(([k, v]) => `${k}=${v.kind}:${v.h}`).sort().join("|");

const up = (ps: P2[], h: number) => ps.map((p) => ({ x: p.x, y: p.y - h }));
/** a block moved up by `h` (its faces, its box and its peak) */
export function liftBlock(b: IsoBlock, h: number): IsoBlock {
  return { ...b, top: up(b.top, h), left: up(b.left, h), right: up(b.right, h), peak: { x: b.peak.x, y: b.peak.y - h }, box: { x0: b.box.x0, x1: b.box.x1, y0: b.box.y0 - h, y1: b.box.y1 - h } };
}
/** where a block stands on the ground: its top brought down to its foot */
export function footprint(b: IsoBlock): P2[] {
  const tall = b.left[3].y - b.left[0].y;
  return b.top.map((p) => ({ x: p.x, y: p.y + tall }));
}

/** the lifted blocks, back to front (map order), each moved up */
export function liftedBlocks(map: IsoMap, index: Map<string, number>, lifts: Map<string, Lift>): { key: string; lift: Lift; block: IsoBlock; ground: IsoBlock }[] {
  const out: { n: number; key: string; lift: Lift; block: IsoBlock; ground: IsoBlock }[] = [];
  for (const [key, lift] of lifts) {
    const i = index.get(key), n = i !== undefined ? map.order.get(i) : undefined;
    if (n === undefined) continue;
    const ground = map.blocks[n];
    out.push({ n, key, lift, ground, block: liftBlock(ground, lift.h) });
  }
  return out.sort((a, b) => a.n - b.n).map(({ key, lift, block, ground }) => ({ key, lift, block, ground }));
}

/** the lifted block under `p` (the map's units), front-most first; null if none (then the city's, blockAt) */
export function liftedBlockAt(map: IsoMap, index: Map<string, number>, lifts: Map<string, Lift>, p: P2): IsoBlock | null {
  const all = liftedBlocks(map, index, lifts);
  for (let i = all.length - 1; i >= 0; i--) {
    const b = all[i].block;
    if (p.x < b.box.x0 || p.x > b.box.x1 || p.y < b.box.y0 || p.y > b.box.y1) continue;
    if (inPoly(p, b.top) || inPoly(p, b.left) || inPoly(p, b.right)) return b;
  }
  return null;
}

/** what a belt covers on screen at scale `k` (iso units): its strip and its packages, with their labels over them */
export function beltObstacles(belts: Belt[], wu: number, k: number): Box[] {
  return belts.map((b) => {
    const ps = [b.h + 3.5 * wu, 0].flatMap((h) => [iso(b.x0, b.z0, h), iso(b.x1, b.z0, h), iso(b.x0, b.z1, h), iso(b.x1, b.z1, h)]);
    const box = boxOf(ps);
    return { ...box, y0: box.y0 - 16 / k };
  });
}

/** a lifted block's name: its file's basename */
export const nameOf = (key: string) => key.split("\n")[1]?.split("/").pop() ?? "";
/** the room a lifted block's name takes over it (px), when it shows */
export const NAME_PX = 14;
/** a lifted block's name shows only when the block is this wide on screen (px) */
export const NAME_MIN_PX = 8;
/** a lift never goes under this, so the block still clears the roofs (4.2) */
export const MIN_LIFT = 5.5;

/**
 * Each lift capped (T216): as high as it can go, up to its kind's height, without the lifted block (and its name over
 * it) overlapping `obstacles` (the belts and their packages); never under MIN_LIFT.
 */
export function capLifts(map: IsoMap, index: Map<string, number>, lifts: Map<string, Lift>, obstacles: Box[], k: number): Map<string, Lift> {
  const out = new Map<string, Lift>();
  for (const [key, lift] of lifts) {
    const i = index.get(key), n = i !== undefined ? map.order.get(i) : undefined;
    if (n === undefined) continue;
    const b = map.blocks[n], half = (nameOf(key).length * 6.2 + 6) / 2 / k;
    const clear = (h: number, name: boolean) => {
      // (its box, and its name over it: 10 px monospace, centred on its peak)
      const box = liftBlock(b, h).box;
      const room = name ? { x0: Math.min(box.x0, b.peak.x - half), x1: Math.max(box.x1, b.peak.x + half), y0: box.y0 - NAME_PX / k, y1: box.y1 } : box;
      return !obstacles.some((o) => overlap(o, room));
    };
    // (the highest with its name over it; else the highest for the block alone, its name then under it)
    let h = lift.h;
    while (h > MIN_LIFT && !clear(h, true)) h -= 0.5;
    if (clear(Math.max(MIN_LIFT, h), true)) { out.set(key, { ...lift, h: Math.max(MIN_LIFT, h) }); continue; }
    h = lift.h;
    while (h > MIN_LIFT && !clear(h, false)) h -= 0.5;
    out.set(key, { ...lift, h: Math.max(MIN_LIFT, h), nameBelow: true });
  }
  return out;
}
