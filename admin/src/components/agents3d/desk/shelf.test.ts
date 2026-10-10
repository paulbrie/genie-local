import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { boardTop, bookSpots, GAP, PER_SHELF, SHELF_BOOKS } from "./shelf";
import { BOARD, FLOOR_Y, SHELF, WALK } from "./world";

const hashes = (n: number) => Array.from({ length: n }, (_, i) => `c${String(i).padStart(4, "0")}`);

describe("the commits bookshelf (T95)", () => {
  it("the newest at the right end of the top shelf, older ones leftwards, then down a shelf", () => {
    const spots = bookSpots(hashes(PER_SHELF + 2));
    const newest = spots.get(`c${String(PER_SHELF + 1).padStart(4, "0")}`)!;
    assert.deepEqual([newest.shelf, newest.slot], [0, PER_SHELF - 1]);
    const before = spots.get(`c${String(PER_SHELF).padStart(4, "0")}`)!;
    assert.deepEqual([before.shelf, before.slot], [0, PER_SHELF - 2]);
    assert.ok(before.x < newest.x);
    const second = spots.get("c0001")!;
    assert.deepEqual([second.shelf, second.slot], [1, PER_SHELF - 1]);
    assert.ok(second.y < newest.y);
  });
  it("full: keeps the newest SHELF_BOOKS and drops the oldest", () => {
    const all = hashes(SHELF_BOOKS + 7);
    const spots = bookSpots(all);
    assert.equal(spots.size, SHELF_BOOKS);
    for (const h of all.slice(0, 7)) assert.equal(spots.has(h), false);
    assert.equal(spots.has(all[all.length - 1]), true);
    const slots = new Set([...spots.values()].map((s) => `${s.shelf}/${s.slot}`));
    assert.equal(slots.size, SHELF_BOOKS);
  });
  it("every book stands on its board, inside the shelf, under the board above", () => {
    for (const s of bookSpots(hashes(SHELF_BOOKS)).values()) {
      assert.ok(Math.abs(s.y - s.h / 2 - boardTop(s.shelf)) < 1e-9);
      assert.ok(s.h < GAP);
      assert.ok(s.x - s.w / 2 >= SHELF.x - SHELF.w / 2 + SHELF.side - 1e-9 && s.x + s.w / 2 <= SHELF.x + SHELF.w / 2 - SHELF.side + 1e-9);
    }
  });
  it("repeatable sizes per commit; stands on the floor, left of the board, past the walking ring", () => {
    assert.deepEqual(bookSpots(["abc"]).get("abc"), bookSpots(["abc"]).get("abc"));
    assert.ok(boardTop(SHELF.shelves - 1) > FLOOR_Y);
    assert.ok(SHELF.x + SHELF.w / 2 < BOARD.x - BOARD.w / 2);
    assert.ok(Math.hypot(SHELF.x, SHELF.z + SHELF.d / 2) > WALK.r1);
  });
});
