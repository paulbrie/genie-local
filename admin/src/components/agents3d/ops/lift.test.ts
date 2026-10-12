import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityLayout } from "@/lib/city-layout";

import { blockAt, isoMap, MAX_H } from "./iso";
import { beltObstacles, capLifts, footprint, LIFT, liftBlock, liftedBlockAt, liftedBlocks, liftsKey, liftsOf, MIN_LIFT, NAME_PX } from "./lift";
import { overlap } from "./server";
import type { OpsLink } from "./model";

const link = (file: string, kind: OpsLink["kind"], fade = 1): OpsLink => ({ by: "Bob", file, kind, fade, ms: 0 });
// (three buildings in a row, as the layout gives them)
const layout = {
  buildings: ["a", "b", "c"].map((p, i) => ({ key: `/r\n${p}.ts`, repo: "/r", path: `${p}.ts`, ext: "ts", x: i * 4, z: 0, w: 3, d: 3, h: 2, size: 100 })),
  index: new Map(["a", "b", "c"].map((p, i) => [`/r\n${p}.ts`, i])),
  districts: [], cities: [], size: 12,
} as unknown as CityLayout;

describe("files being worked on, lifted (T216)", () => {
  it("edited or read lately: an edit over a read, an edit higher; claimed only, or faded out: not lifted", () => {
    const l = liftsOf([link("/r\na.ts", "read"), link("/r\na.ts", "edit"), link("/r\nb.ts", "read"), link("/r\nc.ts", "claim"), link("/r\nd.ts", "edit", 0)]);
    assert.deepEqual([...l].map(([k, v]) => [k.split("\n")[1], v.kind]).sort(), [["a.ts", "edit"], ["b.ts", "read"]]);
    assert.ok(LIFT.edit > LIFT.read && LIFT.read > MAX_H * 1.4, "over the tallest roof");
    assert.equal(liftsKey(l), liftsKey(liftsOf([link("/r\nb.ts", "read"), link("/r\na.ts", "edit")])));
  });
  it("a lifted block: moved up whole, its shadow where it stood on the ground", () => {
    const m = isoMap(layout), b = m.blocks[0], up = liftBlock(b, 5);
    up.top.forEach((p, i) => assert.ok(p.x === b.top[i].x && Math.abs(p.y - (b.top[i].y - 5)) < 1e-9));
    assert.ok(Math.abs(up.peak.y - (b.peak.y - 5)) < 1e-9 && Math.abs(up.box.y0 - (b.box.y0 - 5)) < 1e-9);
    const foot = footprint(b);
    // (the top's corner over the near-left foot comes down onto it)
    assert.ok(Math.abs(foot[3].x - b.left[3].x) < 1e-9 && Math.abs(foot[3].y - b.left[3].y) < 1e-9);
  });
  it("hover and the menus find the lifted block, where it is in the air, before the city's", () => {
    const m = isoMap(layout), lifts = liftsOf([link("/r\nb.ts", "edit")]);
    const lifted = liftedBlocks(m, layout.index, lifts)[0].block, mid = { x: (lifted.top[0].x + lifted.top[2].x) / 2, y: (lifted.top[0].y + lifted.top[2].y) / 2 };
    assert.equal(liftedBlockAt(m, layout.index, lifts, mid)?.key, "/r\nb.ts");
    assert.equal(blockAt(m, mid), null, "nothing of the city's up there");
    const ground = m.blocks[m.order.get(1)!];
    assert.equal(liftedBlockAt(m, layout.index, lifts, ground.peak), null, "its spot below: the city's (blockAt) again");
  });
  it("capped near a belt: as high as it can go without its box and name meeting the belt's packages, never under the roofs", () => {
    const m = isoMap(layout), lifts = liftsOf([link("/r\nb.ts", "edit"), link("/r\nc.ts", "read")]), k = 4;
    const b = m.blocks[m.order.get(1)!];
    // (a belt just over b's spot on screen, as a city's far belt can be)
    const belt = { x0: b.box.x0, x1: b.box.x0 + 0.4, y0: b.box.y0 - 12, y1: b.box.y0 - 7 };
    const capped = capLifts(m, layout.index, lifts, [belt], k), lb = capped.get("/r\nb.ts")!, h = lb.h;
    assert.ok(h < LIFT.edit && h >= MIN_LIFT, `capped to ${h}`);
    const box = liftBlock(b, h).box;
    // (clear of the belt, with its name over it; or, no room for that, the block alone, its name under it)
    assert.ok(h === MIN_LIFT || !overlap(belt, lb.nameBelow ? box : { ...box, y0: box.y0 - NAME_PX / k }), "clear of the belt");
    assert.equal(capped.get("/r\nc.ts")!.h, LIFT.read, "a block far from it rises all the way");
    assert.ok(beltObstacles([{ repo: "/r", x0: 0, x1: 10, z0: -6, z1: -4, h: 1 }], 1, k)[0].y0 < 0);
  });
});
