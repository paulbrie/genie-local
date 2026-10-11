import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CityLayout } from "@/lib/city-layout";
import { blockAt, districtAt, districtLabels, districtName, iso, isoMap, litDrawList, MAX_H } from "./iso";

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
  it("names neighbourhoods biggest first, only where they fit, never overlapping; finds the folder under a point (T192)", () => {
    const L = layout([b("x", 0, 0)]);
    const d = (dir: string, depth: number, x: number, z: number, w: number) => ({ repo: "r", dir, depth, x, z, w, d: w });
    L.districts = [d("src", 0, -40, -40, 80), d("src/components", 1, -40, -40, 40), d("src/lib", 1, 0, 0, 40), d("docs/tiny", 1, 30, -40, 2)];
    const m = isoMap(L), toPx = (p: { x: number; y: number }) => ({ x: p.x * 4, y: p.y * 4 });
    const ls = districtLabels(m, toPx, 4, []);
    assert.equal(ls[0].text, "src", "the biggest first");
    assert.ok(ls.some((l) => l.text === "src/components") && ls.some((l) => l.text === "src/lib"));
    assert.ok(!ls.some((l) => l.text === "docs/tiny"), "too small to name: on hover only");
    for (const a of ls) for (const c of ls) if (a !== c) assert.ok(!(Math.abs(a.x - c.x) * 2 < a.w + c.w && Math.abs(a.y - c.y) * 2 < a.h + c.h), `${a.text} over ${c.text}`);
    // (a city's name where a label would go: that label gives way)
    const big = ls[0];
    assert.ok(!districtLabels(m, toPx, 4, [{ x: big.x, y: big.y, w: 40, h: 14 }]).some((l) => l.text === "src"));
    assert.equal(districtAt(m, iso(-30, -30))?.dir, "src/components", "the deepest folder there");
    assert.equal(districtAt(m, iso(100, 100)), null);
    assert.equal(districtName("admin/src/components/agents3d"), "components/agents3d");
  });
});
