import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bubbleAt, estimate, layoutBubbles, MIN_U, wrap } from "./bubbles";
import { BUBBLE_MS, bubbleOf, type OpsAgent } from "./model";

const T = Date.parse("2026-10-11T18:00:00Z"), iso = (ago: number) => new Date(T - ago).toISOString();
const agent = (key: string, bubble: OpsAgent["bubble"]): OpsAgent => ({
  key, name: key, color: "#123456", doing: "type", waitFor: null, busy: true, lastTool: null, lastKind: null, focus: null, focusPath: null, task: null, managing: 0, spark: [], bubble,
});

describe("thinking bubbles (T205)", () => {
  it("shows the last 3 thinking lines of the last 2 minutes, the newest last, older ones fainter; nothing else (T205b)", () => {
    const steps = [
      { t: iso(5 * 60_000), kind: "tool" as const, text: "too old" },
      { t: iso(90_000), kind: "tool" as const, text: "reading a.ts" },
      { t: iso(70_000), kind: "think" as const, text: "a first: the gap" },
      { t: iso(60_000), kind: "say" as const, text: "Done: a works" },
      { t: iso(20_000), kind: "tool" as const, text: "editing b.ts" },
      { t: iso(5_000), kind: "think" as const, text: "the ring needs a gap" },
    ];
    const b = bubbleOf(steps, T)!;
    assert.deepEqual(b.lines.map((l) => l.text), ["a first: the gap", "the ring needs a gap"], "thinking only");
    assert.ok(b.lines[0].fade < b.lines[1].fade && b.lines[1].fade <= 1);
    assert.equal(b.thinking, true);
    assert.equal(bubbleOf(steps.slice(0, 1), T), null, "nothing recent: no bubble");
    assert.equal(bubbleOf(steps.filter((x) => x.kind !== "think"), T), null, "no thinking: no bubble");
    assert.equal(bubbleOf([{ t: iso(BUBBLE_MS + 1000), kind: "tool", text: "x" }], T), null);
  });
  it("lays bubbles out over the heads without overlaps (raised, then narrowed), none when zoomed far out; finds the one clicked", () => {
    const line = { kind: "tool" as const, text: "running: a fairly long description of a check", fade: 1 };
    const agents = ["a", "b", "c", "d"].map((k) => agent(k, { lines: [line, line], thinking: false }));
    const heads = new Map(agents.map((a, i) => [a.key, { x: 200 + i * 120, y: 300 }]));
    const boxes = layoutBubbles(agents, heads, 1);
    assert.equal(boxes.length, 4);
    for (const p of boxes) for (const q of boxes) if (p !== q) assert.ok(!(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h), `${p.key} over ${q.key}`);
    assert.ok(boxes.every((b) => b.y + b.h <= 300), "above the heads");
    assert.deepEqual(layoutBubbles(agents, heads, MIN_U / 2), [], "zoomed far out");
    // (figures crowded together: bubbles keep a readable width, and any that can't be placed without overlapping are left out)
    const crowded = layoutBubbles(agents, new Map(agents.map((a, i) => [a.key, { x: 200 + i * 20, y: 300 }])), 1);
    assert.ok(crowded.length >= 1 && crowded.length < agents.length && crowded.every((b) => b.w >= 140));
    const b = boxes[1];
    assert.equal(bubbleAt(boxes, { x: b.x + 2, y: b.y + 2 })?.key, b.key);
    assert.equal(bubbleAt(boxes, { x: 0, y: 0 }), null);
  });
  it("wraps a thought by words on two lines at most, cutting only past that (T205d)", () => {
    const m = (t: string) => t.length * 10;
    assert.deepEqual(wrap("the ring needs a gap", 110, m), ["the ring", "needs a gap"]);
    assert.deepEqual(wrap("short", 100, m), ["short"]);
    const long = wrap("keep your lane and drive is now down to the last two failures in the check", 100, m);
    assert.equal(long.length, 2);
    assert.ok(long[1].endsWith("…") && m(long[1]) <= 100);
    assert.ok(m(wrap("x".repeat(30), 100, m)[0]) <= 100, "a word longer than the width is cut");
    assert.ok(estimate("abc") > 0);
  });
});
