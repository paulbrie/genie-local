import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { makeTrip, SETTLE_MS, ShelfRun, shelfPath, STAND_MS, tripAt, tripMs, walkerOf } from "./walk";
import { CHAIR_R, seatAt, SHELF_STAND, WALK } from "./world";

const seat = seatAt(1, 6);
/** The run's trip, read fresh (assert.equal narrows `run.trip` itself). */
const tripOf = (run: ShelfRun) => run.trip;

describe("Alice's way to the shelf (T95)", () => {
  it("from the seat, a step aside, then round the walking ring, to the spot in front of the shelf", () => {
    for (const s of [seatAt(0, 6), seatAt(3, 6), seatAt(5, 6), seatAt(0, 1)]) {
      const p = shelfPath(s);
      assert.deepEqual(p[0], { x: s.x, z: s.z });
      assert.deepEqual(p[p.length - 1], { x: SHELF_STAND.x, z: SHELF_STAND.z });
      // Past the side step, the way keeps clear of the chairs.
      for (const q of p.slice(2)) assert.ok(Math.hypot(q.x, q.z) >= WALK.r0 - 1e-9 && Math.hypot(q.x, q.z) > CHAIR_R);
    }
  });
  it("stands, walks out, places, walks back, sits; then the trip is over", () => {
    const t = makeTrip(seat, ["a"], 1000);
    assert.equal(tripAt(t, 999), null);
    assert.equal(tripAt(t, 1000)!.phase, "stand");
    const out = tripAt(t, 1000 + STAND_MS + 10)!;
    assert.equal(out.phase, "out");
    assert.ok(out.moving && out.carrying);
    const placeAt = 1000 + tripMs(t) / 2;
    const mid = tripAt(t, placeAt)!;
    assert.equal(mid.phase, "place");
    assert.ok(Math.abs(mid.x - SHELF_STAND.x) < 1e-9 && Math.abs(mid.z - SHELF_STAND.z) < 1e-9);
    assert.equal(tripAt(t, 1000 + tripMs(t) - 1)!.phase, "sit");
    assert.equal(tripAt(t, 1000 + tripMs(t) + 1), null);
    // A few seconds.
    assert.ok(tripMs(t) > 4000 && tripMs(t) < 15000, `${tripMs(t)} ms`);
  });
  it("the books leave the hands during the place phase", () => {
    const t = makeTrip(seat, ["a"], 0);
    let carried = true;
    for (let ms = 0; ms <= tripMs(t); ms += 50) {
      const p = tripAt(t, ms);
      if (!p) break;
      if (!p.carrying) carried = false;
      if (carried) assert.ok(p.phase === "stand" || p.phase === "out" || p.phase === "place");
    }
    assert.equal(carried, false);
  });
});

describe("when Alice walks (T95)", () => {
  it("what's on the shelf when the page opens stays; a new commit starts one trip", () => {
    const run = new ShelfRun();
    run.update(["a", "b"], 0, true, seat);
    assert.equal(tripOf(run), null);
    run.update(["a", "b", "c"], 100, true, seat);
    assert.deepEqual(tripOf(run)?.books, ["c"]);
    assert.deepEqual([...run.hidden(200)], ["c"]);
  });
  it("commits that come together go in one trip; ones during a trip wait for the next", () => {
    const run = new ShelfRun();
    run.update(["a"], 0, true, seat);
    run.update(["a", "b", "c"], 100, true, seat);
    assert.deepEqual(tripOf(run)?.books, ["b", "c"]);
    run.update(["a", "b", "c", "d"], 2000, true, seat);
    assert.deepEqual(tripOf(run)?.books, ["b", "c"]);
    assert.deepEqual(run.pending, ["d"]);
    const end = 100 + tripMs(tripOf(run)!) + 1;
    run.update(["a", "b", "c", "d"], end, true, seat);
    assert.deepEqual(tripOf(run)?.books, ["d"]);
  });
  it("nobody to walk: the book appears at once, settling, then still", () => {
    const run = new ShelfRun();
    run.update(["a"], 0, true, null);
    run.update(["a", "b"], 100, true, null);
    assert.equal(tripOf(run), null);
    assert.equal(run.hidden(100).size, 0);
    assert.ok(run.settle("b", 100) > 0 && run.busy(100));
    run.update(["a", "b"], 100 + SETTLE_MS + 1, true, null);
    assert.equal(run.settle("b", 100 + SETTLE_MS + 1), 0);
    assert.equal(run.busy(100 + SETTLE_MS + 1), false);
  });
  it("in replay nothing walks or hides; back live, only newer commits make a trip", () => {
    const run = new ShelfRun();
    run.update(["a"], 0, true, seat);
    run.update(["a", "b"], 100, false, seat);
    assert.equal(tripOf(run), null);
    assert.equal(run.hidden(100).size, 0);
    run.update(["a", "b"], 200, true, seat);
    run.update(["a", "b"], 300, true, seat);
    assert.equal(tripOf(run), null);
  });
});

describe("who walks (T95)", () => {
  it("the manager at the table, else Alice by name, else nobody", () => {
    assert.equal(walkerOf([{ name: "Bob", role: "peer" }, { name: "Boss", role: "manager" }]), 1);
    assert.equal(walkerOf([{ name: "Bob", role: "peer" }, { name: "alice", role: "peer" }]), 1);
    assert.equal(walkerOf([{ name: "Bob", role: "peer" }]), -1);
  });
});
