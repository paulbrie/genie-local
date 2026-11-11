import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { squarify } from "./treemap";

describe("squarify", () => {
  const area = (r: { w: number; h: number }) => r.w * r.h;
  it("gives each item its share of the box, the whole box and nothing over it", () => {
    const rects = squarify(
      [
        { key: "a", value: 6 },
        { key: "b", value: 6 },
        { key: "c", value: 4 },
        { key: "d", value: 3 },
        { key: "e", value: 2 },
        { key: "f", value: 2 },
        { key: "g", value: 1 },
      ],
      0,
      0,
      6,
      4,
    );
    assert.equal(rects.length, 7);
    const total = rects.reduce((n, r) => n + area(r), 0);
    assert.ok(Math.abs(total - 24) < 1e-9);
    const a = rects.find((r) => r.key === "a")!;
    assert.ok(Math.abs(area(a) - 6) < 1e-9);
    for (const r of rects) {
      assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 6 + 1e-9 && r.y + r.h <= 4 + 1e-9, r.key);
    }
  });
  it("keeps the tiles near square (the classic example's worst ratio)", () => {
    const rects = squarify([6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ key: String(i), value: v })), 0, 0, 6, 4);
    const ratio = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
    assert.ok(ratio < 3, `worst ratio ${ratio}`);
  });
  it("leaves out what's empty, and has nothing for an empty box", () => {
    assert.deepEqual(
      squarify([{ key: "a", value: 0 }, { key: "b", value: 2 }], 10, 20, 4, 2),
      [{ key: "b", x: 10, y: 20, w: 4, h: 2 }],
    );
    assert.deepEqual(squarify([{ key: "a", value: 1 }], 0, 0, 0, 5), []);
  });
});
