import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { glyphTicker, SPIN, TICK_MS } from "./glyph-ticker";

function fakeEnv() {
  const timers = new Map<number, () => void>();
  let id = 0, visible = true;
  const asked: number[] = [];
  return {
    env: {
      setInterval: (f: () => void, ms: number) => { timers.set(++id, f); asked.push(ms); return id; },
      clearInterval: (i: number) => void timers.delete(i),
      visible: () => visible,
    },
    tick: () => timers.forEach((f) => f()),
    timers,
    hide: (h: boolean) => { visible = !h; },
    asked: () => asked,
  };
}

describe("Claude glyph ticker (T169)", () => {
  it("runs one timer for every working glyph, only while one works", () => {
    const f = fakeEnv(), t = glyphTicker(f.env);
    assert.equal(t.running(), false);
    const a: string[] = [], b: string[] = [];
    const stopA = t.add((g) => a.push(g)), stopB = t.add((g) => b.push(g));
    assert.equal(f.timers.size, 1);
    assert.deepEqual(f.asked(), [TICK_MS]);
    for (let i = 0; i < SPIN.length; i++) f.tick();
    assert.equal(new Set(a).size, 6, "it goes through every glyph");
    assert.notDeepEqual(a.slice(1, 4), b.slice(1, 4), "each its own phase");
    stopA();
    assert.equal(t.running(), true);
    stopB();
    assert.equal(t.running(), false);
    assert.equal(f.timers.size, 0);
  });
  it("stops while the tab is hidden and starts again when it shows", () => {
    const f = fakeEnv(), t = glyphTicker(f.env);
    t.add(() => {});
    f.hide(true);
    t.sync();
    assert.equal(t.running(), false);
    f.hide(false);
    t.sync();
    assert.equal(t.running(), true);
  });
});
