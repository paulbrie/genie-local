import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { arcHeight, FLIGHT_MS, flightState, offTable, planeAt, STAGGER_MS, stagger, UNFOLD_MS } from "./planes";

const from = { x: -10, y: 1.5, z: -8 };
const to = { x: 9, y: 0.2, z: -9 };

describe("paper planes (T106)", () => {
  it("leaves the sender's hands and lands at the receiver's place", () => {
    const a = planeAt(from, to, 0, 1);
    assert.ok(Math.hypot(a.x - from.x, a.y - from.y, a.z - from.z) < 1e-9);
    const b = planeAt(from, to, 1, 1);
    assert.ok(Math.hypot(b.x - to.x, b.y - to.y, b.z - to.z) < 1e-9);
    assert.ok(Math.abs(b.roll) < 1e-9, "no bank as it lands");
  });
  it("flies an arc above the straight line, highest near the middle, banking and bobbing on the way", () => {
    const mid = planeAt(from, to, 0.5, 1);
    const line = (from.y + to.y) / 2;
    assert.ok(mid.y - line > arcHeight(from, to) * 0.85);
    let rolls = 0;
    let prevY = from.y;
    let rises = 0;
    let falls = 0;
    for (let k = 0.05; k <= 1; k += 0.05) {
      const p = planeAt(from, to, k, 1);
      if (Math.abs(p.roll) > 0.05) rolls++;
      if (p.y > prevY) rises++;
      else falls++;
      prevY = p.y;
      // Never below where it lands, nor off the way between the two seats.
      assert.ok(p.y >= Math.min(from.y, to.y) - 1e-9);
    }
    assert.ok(rolls > 5 && rises > 3 && falls > 3);
  });
  it("several from one sender at once take off one after another; others aren't held up", () => {
    const s = stagger([
      { id: "a", from: "Tom", at: 1000 },
      { id: "b", from: "Tom", at: 1000 },
      { id: "c", from: "Tom", at: 1100 },
      { id: "d", from: "Bob", at: 1000 },
      { id: "e", from: "Tom", at: 5000 },
    ]);
    assert.equal(s.get("a"), 1000);
    assert.equal(s.get("b"), 1000 + STAGGER_MS);
    assert.equal(s.get("c"), 1000 + 2 * STAGGER_MS);
    assert.equal(s.get("d"), 1000);
    assert.equal(s.get("e"), 5000);
  });
  it("flies, then unfolds, then is gone; nothing before take-off", () => {
    assert.equal(flightState(-1), null);
    assert.deepEqual(flightState(FLIGHT_MS / 2), { phase: "fly", k: 0.5 });
    assert.deepEqual(flightState(FLIGHT_MS + UNFOLD_MS / 2), { phase: "unfold", u: 0.5 });
    assert.equal(flightState(FLIGHT_MS + UNFOLD_MS), null);
  });
  it("to someone not at the table: off the edge on the far side, down towards the floor", () => {
    const p = offTable({ x: 0, y: 1, z: -17 }, 16, -2.75);
    assert.ok(p.z > 16 && Math.abs(p.x) < 1e-9);
    assert.ok(p.y < 0);
  });
});
