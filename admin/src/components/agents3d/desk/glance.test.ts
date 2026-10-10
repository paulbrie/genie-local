import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { glanceAt, HEAD_SHARE, SLOT_MS } from "./glance";

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SLOT_MS);

/** The glances over `ms` from T0: each start time and how long its move lasts, and each hold, sampled every 5 ms. */
function trace(seed: number, ms: number) {
  const moves: { at: number; len: number }[] = [];
  const holds: number[] = [];
  let moving = false;
  let since = T0;
  let headMoves = 0;
  let wasHead = 0;
  for (let t = T0; t < T0 + ms; t += 5) {
    const g = glanceAt(seed, t);
    const glancing = g.moving && g.head === wasHead;
    if (glancing && !moving) {
      if (moves.length) holds.push(t - since);
      moves.push({ at: t - T0, len: 0 });
    }
    if (!glancing && moving) {
      moves[moves.length - 1].len = t - T0 - moves[moves.length - 1].at;
      since = t;
    }
    if (g.head !== wasHead && g.head > wasHead) headMoves++;
    wasHead = g.head;
    moving = glancing;
  }
  return { moves, holds, headMoves };
}

describe("a thinking agent's glances", () => {
  it("quick glances (80–120 ms), held 0.6–2.5 s", () => {
    const { moves, holds } = trace(11, SLOT_MS - 3000);
    assert.ok(moves.length >= 6, `${moves.length} glances`);
    for (const m of moves.slice(0, -1)) assert.ok(m.len >= 75 && m.len <= 130, `move ${m.len} ms`);
    for (const h of holds) assert.ok(h >= 590 && h <= 2510, `hold ${h} ms`);
  });
  it("mostly up-left and up-right; sometimes elsewhere", () => {
    const where = new Map<string, number>();
    for (let seed = 0; seed < 40; seed++)
      for (let t = T0; t < T0 + SLOT_MS * 3; t += 997) {
        const g = glanceAt(seed, t);
        if (g.moving) continue;
        const k = g.y > 0.3 ? (g.x < 0 ? "up-left" : "up-right") : g.x === 0 && g.y === 0 ? "centre" : "other";
        where.set(k, (where.get(k) ?? 0) + 1);
      }
    const n = [...where.values()].reduce((a, b) => a + b, 0);
    const up = ((where.get("up-left") ?? 0) + (where.get("up-right") ?? 0)) / n;
    assert.ok(up > 0.5 && up < 0.8, `up share ${up}`);
    assert.ok((where.get("centre") ?? 0) > 0 && (where.get("other") ?? 0) > 0);
  });
  it("repeatable per agent and wall-clock time; agents don't move in step", () => {
    for (const t of [T0 + 1234, T0 + 9876, T0 + SLOT_MS + 50]) assert.deepEqual(glanceAt(5, t), glanceAt(5, t));
    const a = trace(5, 10_000).moves.map((m) => m.at);
    const b = trace(6, 10_000).moves.map((m) => m.at);
    assert.notDeepEqual(a, b);
  });
  it("blinks with some glances, and the head follows a little after long holds only", () => {
    let blinks = 0;
    let heads = 0;
    let maxHead = 0;
    for (let seed = 0; seed < 20; seed++)
      for (let t = T0; t < T0 + SLOT_MS; t += 10) {
        const g = glanceAt(seed, t);
        if (g.blink) blinks++;
        if (g.head > 0) heads++;
        maxHead = Math.max(maxHead, g.head);
      }
    assert.ok(blinks > 0 && heads > 0);
    assert.ok(maxHead <= HEAD_SHARE + 1e-9);
  });
  it("still between glances: no frames asked for, and it says when the next movement starts", () => {
    for (let t = T0; t < T0 + 8000; t += 37) {
      const g = glanceAt(9, t);
      if (g.moving) continue;
      assert.ok(g.inMs > 0, `inMs ${g.inMs} at ${t - T0}`);
      // Nothing changes until then.
      const later = glanceAt(9, t + g.inMs - 1);
      assert.equal(later.x, g.x);
      assert.equal(later.y, g.y);
      assert.equal(later.head, g.head);
      assert.equal(later.blink, false);
    }
  });
});
