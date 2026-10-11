import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cssBetween, FIT_VIEW, MIN_S, panBy, viewFit, viewFromStore, viewOfBox, viewToStore, zoomAt } from "./map-view";

const fit = { k: 4, ox: 100, oy: 50 };
const at = (v: { s: number; tx: number; ty: number }, q: { x: number; y: number }) => ({ x: v.s * q.x + v.tx, y: v.s * q.y + v.ty });

describe("map view (T200)", () => {
  it("zooms about the pointer: the point under it stays put; held to its range", () => {
    const m = { x: 300, y: 200 }, v = zoomAt(FIT_VIEW, 2, m, 10);
    const q = { x: 300, y: 200 }; // (on the fitted map, under the pointer before)
    assert.deepEqual(at(v, q), m);
    assert.equal(zoomAt(v, 100, m, 10).s, 10);
    assert.equal(zoomAt(FIT_VIEW, 0.01, m, 10).s, MIN_S);
  });
  it("applies the view to the fit (identity at fit), pans in pixels", () => {
    assert.deepEqual(viewFit(fit, FIT_VIEW), fit);
    const v = panBy(zoomAt(FIT_VIEW, 2, { x: 0, y: 0 }, 10), 10, -5);
    assert.deepEqual(viewFit(fit, v), { k: 8, ox: 210, oy: 95 });
  });
  it("the gesture's CSS takes what was drawn for one view to the next", () => {
    const a = { s: 2, tx: 10, ty: 20 }, b = { s: 4, tx: -30, ty: 5 };
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(cssBetween(a, b))!;
    const [dx, dy, r] = [Number(m[1]), Number(m[2]), Number(m[3])], q = { x: 7, y: 9 };
    const drawn = at(a, q);
    assert.ok(Math.abs(drawn.x * r + dx - at(b, q).x) < 0.01 && Math.abs(drawn.y * r + dy - at(b, q).y) < 0.01);
  });
  it("frames a box (a city, on a double-click) in the middle", () => {
    const v = viewOfBox({ x0: 100, y0: 100, x1: 200, y1: 150 }, 1000, 600, 50);
    const c = at(v, { x: 150, y: 125 });
    assert.ok(Math.abs(c.x - 500) < 1e-9 && Math.abs(c.y - 300) < 1e-9);
    assert.equal(v.s, Math.min((1000 - 80) / 100, (600 - 80) / 50));
  });
  it("keeps the view for the session through a resize; refuses junk", () => {
    const v = { s: 3, tx: -200, ty: -100 }, kept = viewToStore(v, 800, 600), back = viewFromStore(JSON.parse(JSON.stringify(kept)), 800, 600, 10)!;
    assert.ok(Math.abs(back.tx - v.tx) < 1e-9 && Math.abs(back.ty - v.ty) < 1e-9 && back.s === 3);
    const wider = viewFromStore(kept, 1000, 600, 10)!;
    assert.ok(Math.abs(at(wider, { x: kept.cx, y: kept.cy }).x - 500) < 1e-9, "the same middle in a wider box");
    for (const junk of [null, 3, {}, { s: "2", cx: 0, cy: 0 }, { s: NaN, cx: 0, cy: 0 }]) assert.equal(viewFromStore(junk, 800, 600, 10), null);
  });
});
