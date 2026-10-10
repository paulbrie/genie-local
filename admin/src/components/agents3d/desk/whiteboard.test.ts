import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Snapshot } from "@/lib/agents3d-timeline";

import { HEADER_H, INK, NOTE, PER_COLUMN, placeNotes } from "./whiteboard";
import { BOARD } from "./world";

type Task = Snapshot["tasks"][number];
const task = (i: number, state: Task["state"]): Task => ({ key: `${state}-${i}`, id: `T${i}`, title: `task ${i}`, state, manager: "a", worker: "b", guessed: false, since: i });
const many = (n: number, state: Task["state"]) => Array.from({ length: n }, (_, i) => task(i, state));

describe("the whiteboard's post-its (T164: a larger board, 10% larger notes)", () => {
  const { placed, more } = placeNotes([...many(20, "dispatched"), ...many(20, "in_progress"), ...many(20, "done")]);
  // (a note tilted up to 0.07 rad reaches this far from its centre, across and down)
  const reach = (NOTE / 2) * (Math.cos(0.07) + Math.sin(0.07));

  it("four rows of three a column, Done one fewer", () => {
    assert.equal(PER_COLUMN, 12);
    assert.deepEqual([0, 1, 2].map((c) => placed.filter((p) => p.col === c).length), [12, 12, 11]);
    assert.deepEqual(more, [8, 8, 9]);
  });
  it("no two post-its overlap, tilted as they are", () => {
    for (const a of placed)
      for (const b of placed) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= 2 * reach || Math.abs(a.y - b.y) >= 2 * reach, `${a.task.key} / ${b.task.key}`);
  });
  it("each stays on the board, in its column, under the headings and over the \"+n more\" line", () => {
    const colW = BOARD.w / 3;
    for (const p of placed) {
      const left = -BOARD.w / 2 + p.col * colW;
      assert.ok(p.x - reach > left && p.x + reach < left + colW, `${p.task.key} in its column`);
      assert.ok(p.y + reach < BOARD.h / 2 - HEADER_H, `${p.task.key} under the headings`);
      assert.ok(p.y - reach > -BOARD.h / 2 + 0.5 + INK.more, `${p.task.key} over "+n more"`);
    }
  });
});
