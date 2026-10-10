import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUSY_H, busyTop, labelInk, LANE_GAP, laneTop, packLanes, ROW_PAD, rowHeight, rowTops, TASK_LANE_H } from "./timeline-layout";

describe("packLanes", () => {
  it("keeps tasks that follow each other in one lane", () => {
    assert.deepEqual(packLanes([{ s: 0, e: 10 }, { s: 10, e: 20 }, { s: 25, e: 30 }]), { lane: [0, 0, 0], lanes: 1 });
  });
  it("stacks overlapping ones in sub-lanes, reusing a lane once it is free", () => {
    // T111 (data part) and T111 (Table part) overlap; a third starts after the first ended
    assert.deepEqual(packLanes([{ s: 0, e: 10 }, { s: 5, e: 30 }, { s: 12, e: 20 }]), { lane: [0, 1, 0], lanes: 2 });
    assert.deepEqual(packLanes([{ s: 0, e: 50 }, { s: 1, e: 50 }, { s: 2, e: 50 }]).lanes, 3);
  });
  it("an open task keeps its lane for good; input order is kept in the result", () => {
    assert.deepEqual(packLanes([{ s: 40, e: 45 }, { s: 0, e: null }]), { lane: [1, 0], lanes: 2 });
  });
  it("no tasks: one (empty) lane", () => {
    assert.deepEqual(packLanes([]), { lane: [], lanes: 1 });
  });
});

describe("rows", () => {
  it("a row holds its lanes, the gaps and the busy band; rows stack", () => {
    assert.equal(rowHeight(1), ROW_PAD + TASK_LANE_H + 2 + BUSY_H + 3);
    assert.equal(rowHeight(3) - rowHeight(1), 2 * (TASK_LANE_H + LANE_GAP));
    assert.equal(rowHeight(0), rowHeight(1));
    assert.deepEqual(rowTops([36, 60, 36], 26), [26, 62, 122]);
    assert.equal(laneTop(100, 1), 100 + ROW_PAD + TASK_LANE_H + LANE_GAP);
    // the busy band sits below the last lane
    assert.ok(busyTop(100, rowHeight(2)) >= laneTop(100, 1) + TASK_LANE_H);
  });
  it("lanes are 22–24 px", () => {
    assert.ok(TASK_LANE_H >= 22 && TASK_LANE_H <= 24);
  });
});

describe("labelInk", () => {
  it("dark text on the light bars, white on the dark or faint ones", () => {
    assert.equal(labelInk("#f59e0b", 0.8), "#0b0f17"); // in progress (amber)
    assert.equal(labelInk("#22c55e", 0.8), "#0b0f17"); // done (green)
    assert.equal(labelInk("#3b82f6", 0.45), "#ffffff"); // dispatched (faint blue)
    assert.equal(labelInk("#ef4444", 0.8), "#ffffff"); // blocked (red)
    assert.equal(labelInk("#6b7280", 0.8), "#ffffff"); // cancelled (grey)
  });
});
