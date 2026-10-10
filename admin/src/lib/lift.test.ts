import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIFT_RISE_MS, LIFT_SETTLE_MS, liftActive, liftAt, TOUCH_HOLD_MS } from "./lift";

const L = 3000; // linger
const HOLD = TOUCH_HOLD_MS + L;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("liftAt", () => {
  it("rises over the rise time, eased (slow, fast, slow)", () => {
    assert.equal(liftAt("read", -1, L), 0);
    assert.equal(liftAt("read", 0, L), 0);
    near(liftAt("read", LIFT_RISE_MS / 2, L), 0.5);
    assert.ok(liftAt("read", LIFT_RISE_MS / 4, L) < 0.25);
    assert.equal(liftAt("read", LIFT_RISE_MS, L), 1);
  });
  it("holds while the touch lasts (the hold plus the linger)", () => {
    for (const age of [LIFT_RISE_MS, 2000, TOUCH_HOLD_MS, HOLD]) assert.equal(liftAt("read", age, L), 1, String(age));
    assert.equal(liftAt("read", TOUCH_HOLD_MS + 1, 0) < 1, true); // no linger: settles right after the hold
  });
  it("settles back down over the settle time, then stays down", () => {
    near(liftAt("read", HOLD + LIFT_SETTLE_MS / 2, L), 0.5);
    assert.equal(liftAt("read", HOLD + LIFT_SETTLE_MS, L), 0);
    assert.equal(liftAt("read", HOLD + 60_000, L), 0);
  });
  it("lifts an edit 1.5 storeys, a read 1", () => {
    assert.equal(liftAt("edit", 1000, L), 1.5);
    assert.equal(liftAt("read", 1000, L), 1);
  });
  it("a new touch while up keeps it up (the highest of the touches: no dip)", () => {
    // first touch at 0, a second one 4 s later: over the second's rise the first still holds it at 1
    for (let t = 4000; t <= 4000 + LIFT_RISE_MS; t += 50) assert.equal(Math.max(liftAt("read", t, L), liftAt("read", t - 4000, L)), 1, String(t));
    // and it stays up until the second touch's hold ends
    assert.equal(Math.max(liftAt("read", 4000 + HOLD, L), liftAt("read", HOLD, L)), 1);
    // an edit during a read's hold rises from 1 to 1.5 (never below 1)
    for (let t = 2000; t <= 2000 + LIFT_RISE_MS; t += 50) assert.ok(Math.max(liftAt("read", t, L), liftAt("edit", t - 2000, L)) >= 1);
  });
});

describe("liftActive", () => {
  it("is true from the touch until it has settled", () => {
    assert.equal(liftActive(-1, L), false);
    assert.equal(liftActive(0, L), true);
    assert.equal(liftActive(HOLD + LIFT_SETTLE_MS - 1, L), true);
    assert.equal(liftActive(HOLD + LIFT_SETTLE_MS, L), false);
  });
});
