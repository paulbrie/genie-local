import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CityLayout } from "@/lib/city-layout";
import { blockAt, iso, isoMap, litDrawList, MAX_H } from "./iso";

const b = (key: string, x: number, z: number, h = 1) => ({ key, repo: "r", path: key, x, z, w: 1, d: 1, h, ext: "ts" });
const layout = (bs: ReturnType<typeof b>[]): CityLayout => ({ buildings: bs, index: new Map(bs.map((x, i) => [x.key, i])), districts: [], cities: [{ repo: "r", name: "r", x: -5, z: -5, w: 10, d: 10 }], size: 10 });

describe("isometric map (T163)", () => {
  it("projects x right and down, z left and down, height up", () => {
    assert.ok(iso(1, 0).x > 0 && iso(1, 0).y > 0);
    assert.ok(iso(0, 1).x < 0 && iso(0, 1).y > 0);
    assert.equal(iso(0, 0, 2).y, -2);
  });
  it("orders blocks back to front, caps their height", () => {
    const m = isoMap(layout([b("front", 3, 3), b("back", -3, -3, 99), b("mid", 0, 0)]));
    assert.deepEqual(m.blocks.map((x) => x.key), ["back", "mid", "front"]);
    assert.ok(m.blocks[0].box.y1 - m.blocks[0].box.y0 < MAX_H * 2 + 2, "a huge file's block stays capped");
  });
  it("redraws what stands in front of a lit block, and only that", () => {
    const m = isoMap(layout([b("lit", 0, 0), b("front", 1.2, 1.2, 3), b("aside", -3, 3), b("behind", -1.2, -1.2)]));
    const order = litDrawList(m, [0]).map((n) => m.blocks[n].key);
    assert.deepEqual(order, ["lit", "front"]);
  });
  it("finds the front-most block under a point", () => {
    const m = isoMap(layout([b("a", 0, 0, 1), b("c", 3, 3, 1)]));
    assert.equal(blockAt(m, m.blocks[0].peak)?.key, "a");
    assert.equal(blockAt(m, iso(20, -20)), null);
  });
});
