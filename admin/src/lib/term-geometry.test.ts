import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { clampGeom, DEFAULT_SIZE, parseGeom } from "./term-geometry";

describe("parseGeom", () => {
  it("reads a valid record", () => {
    assert.deepEqual(parseGeom('{"x":10,"y":20,"w":800,"h":500}'), { pos: { x: 10, y: 20 }, size: { w: 800, h: 500 } });
  });
  it("ignores bad or missing values, per pair", () => {
    assert.deepEqual(parseGeom(null), { pos: null, size: null });
    assert.deepEqual(parseGeom("not json"), { pos: null, size: null });
    assert.deepEqual(parseGeom("[1,2]"), { pos: null, size: null });
    assert.deepEqual(parseGeom('"text-xs"'), { pos: null, size: null });
    assert.deepEqual(parseGeom('{"x":-5,"y":20,"w":800,"h":500}'), { pos: null, size: { w: 800, h: 500 } });
    assert.deepEqual(parseGeom('{"x":5,"y":"20","w":800}'), { pos: null, size: null });
    assert.deepEqual(parseGeom('{"x":5,"y":6,"w":null,"h":500}'), { pos: { x: 5, y: 6 }, size: null });
    // NaN / Infinity don't survive JSON; a too-small size is ignored too.
    assert.deepEqual(parseGeom('{"x":5,"y":6,"w":10,"h":10}').size, null);
  });
});

describe("clampGeom", () => {
  it("leaves a window that fits alone", () => {
    assert.deepEqual(clampGeom({ x: 100, y: 80, ...DEFAULT_SIZE }, 1400, 900), { x: 100, y: 80, ...DEFAULT_SIZE });
  });
  it("moves an off-screen window back in, title bar first", () => {
    assert.deepEqual(clampGeom({ x: 1200, y: 800, w: 700, h: 400 }, 1000, 700), { x: 300, y: 300, w: 700, h: 400 });
  });
  it("shrinks a window larger than the viewport to its caps", () => {
    assert.deepEqual(clampGeom({ x: 50, y: 50, w: 1600, h: 1000 }, 1000, 600), { x: 50, y: 50, w: 920, h: 540 });
  });
  it("keeps the top-left on a viewport smaller than the minimum size", () => {
    assert.deepEqual(clampGeom({ x: 50, y: 50, w: 700, h: 400 }, 300, 150), { x: 0, y: 0, w: 300, h: 150 });
  });
});
