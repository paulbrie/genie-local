import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { boardTop, bookSpots, MAX_SHELVES, PER_SHELF, shelfHeight, shelfRows, tableOrder } from "./shelf";
import { BOARD, FLOOR_Y, PERSON_H, SHELF, WALK } from "./world";

const commits = (repo: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ hash: `${repo}-${String(from + i).padStart(4, "0")}`, repo }));
const rows = shelfRows([
  { repo: "admin", name: "admin" },
  { repo: "trafficsim", name: "trafficsim" },
]);

describe("the commits bookshelf, a shelf per project (T133)", () => {
  it("each project's commits on its own shelf, in table order, the newest at the right end", () => {
    const spots = bookSpots(rows, [...commits("admin", 3), ...commits("trafficsim", 2)]);
    const a = spots.get("admin-0002")!;
    const t = spots.get("trafficsim-0001")!;
    assert.deepEqual([a.shelf, a.slot], [0, PER_SHELF - 1]);
    assert.deepEqual([spots.get("admin-0001")!.slot, spots.get("admin-0000")!.slot], [PER_SHELF - 2, PER_SHELF - 3]);
    assert.deepEqual([t.shelf, t.slot], [1, PER_SHELF - 1]);
    assert.ok(t.y < a.y, "the second project's shelf is below the first's");
  });
  it("commits interleaved in time still go to their own shelves", () => {
    const mixed = [{ hash: "a1", repo: "admin" }, { hash: "t1", repo: "trafficsim" }, { hash: "a2", repo: "admin" }];
    const s = bookSpots(rows, mixed);
    assert.deepEqual([s.get("a2")!.slot, s.get("a1")!.slot, s.get("t1")!.slot], [PER_SHELF - 1, PER_SHELF - 2, PER_SHELF - 1]);
  });
  it("a full shelf keeps its project's newest; the others' shelves aren't touched", () => {
    const s = bookSpots(rows, [...commits("admin", PER_SHELF + 5), ...commits("trafficsim", 1)]);
    assert.equal([...s.values()].filter((b) => b.shelf === 0).length, PER_SHELF);
    for (let i = 0; i < 5; i++) assert.equal(s.has(`admin-${String(i).padStart(4, "0")}`), false);
    assert.ok(s.has(`admin-${String(PER_SHELF + 4).padStart(4, "0")}`));
    assert.ok(s.has("trafficsim-0000"));
  });
  it("a project not on the table (or no project) has no shelf and no books", () => {
    const s = bookSpots(rows, [{ hash: "g1", repo: "genie" }, { hash: "n1", repo: null }, { hash: "a1", repo: "admin" }]);
    assert.deepEqual([...s.keys()], ["a1"]);
  });
  it("more projects than shelves: the last shelf takes the rest together, so no commit goes missing", () => {
    const many = Array.from({ length: MAX_SHELVES + 3 }, (_, i) => ({ repo: `p${i}`, name: `P${i}` }));
    const r = shelfRows(many);
    assert.equal(r.length, MAX_SHELVES);
    assert.equal(r[MAX_SHELVES - 1].name, "Other projects (4)");
    assert.deepEqual(r[MAX_SHELVES - 1].repos, ["p5", "p6", "p7", "p8"]);
    const s = bookSpots(r, [{ hash: "x", repo: "p8" }]);
    assert.equal(s.get("x")!.shelf, MAX_SHELVES - 1);
    assert.equal(shelfRows(many.slice(0, MAX_SHELVES)).length, MAX_SHELVES);
  });
  it("the bookcase is as tall as its shelves, up to a top shelf a person reaches", () => {
    assert.ok(shelfHeight(2) < shelfHeight(4));
    assert.equal(shelfHeight(0), shelfHeight(1));
    assert.ok(boardTop(0, MAX_SHELVES) - FLOOR_Y < PERSON_H * 1.2, "the top shelf within reach");
    assert.ok(Math.abs(boardTop(MAX_SHELVES - 1, MAX_SHELVES) - (FLOOR_Y + SHELF.board)) < 1e-9, "the bottom shelf on the floor's board");
  });
  it("every book stands on its board, under the board above, inside the sides", () => {
    for (const s of bookSpots(rows, [...commits("admin", PER_SHELF), ...commits("trafficsim", PER_SHELF)]).values()) {
      assert.ok(Math.abs(s.y - s.h / 2 - boardTop(s.shelf, rows.length)) < 1e-9);
      assert.ok(s.h < SHELF.gap);
      assert.ok(s.x - s.w / 2 >= SHELF.x - SHELF.w / 2 + SHELF.side - 1e-9 && s.x + s.w / 2 <= SHELF.x + SHELF.w / 2 - SHELF.side + 1e-9);
    }
  });
  it("the table's order: the back row first, each row left to right", () => {
    const cities = [{ repo: "front", name: "F" }, { repo: "backRight", name: "BR" }, { repo: "backLeft", name: "BL" }];
    const plates = [{ x: 0, z: 5, d: 4 }, { x: 5, z: -4.6, d: 4 }, { x: -5, z: -5, d: 4 }];
    assert.deepEqual(tableOrder(cities, plates).map((c) => c.repo), ["backLeft", "backRight", "front"]);
  });
  it("bigger (T133), still left of the board and past the walking ring", () => {
    assert.ok(SHELF.w >= 7 * 1.3);
    assert.ok(SHELF.x + SHELF.w / 2 < BOARD.x - BOARD.w / 2 - 0.4);
    assert.ok(Math.hypot(SHELF.x, SHELF.z + SHELF.d / 2) > WALK.r1);
  });
});
