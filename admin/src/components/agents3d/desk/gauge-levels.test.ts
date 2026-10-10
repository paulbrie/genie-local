import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { coreBarsFor, coreBarsKey, coreCells, DEFAULT_CORES, dialKey, dialsFor, EASE_MS, easedAt, easing, faceKey, retarget, type StatsReading } from "./gauge-levels";

const GB = 1024 ** 3;
const reading = (o: Partial<StatsReading> = {}): StatsReading => ({
  cpuPercent: 20,
  memPercent: 50,
  memUsedBytes: 8 * GB,
  memTotalBytes: 16 * GB,
  diskPercent: 30,
  diskUsedBytes: 30 * GB,
  diskTotalBytes: 100 * GB,
  ...o,
});
const level = (o: Partial<StatsReading>, i: number) => dialsFor(reading(o))[i].level;

describe("server dials", () => {
  it("CPU: amber over 70 %, red over 90 %", () => {
    assert.equal(level({ cpuPercent: 70 }, 0), "ok");
    assert.equal(level({ cpuPercent: 71 }, 0), "warn");
    assert.equal(level({ cpuPercent: 90 }, 0), "warn");
    assert.equal(level({ cpuPercent: 91 }, 0), "bad");
  });
  it("MEM by what's available: amber under 4 GB, red under 2.5 GB", () => {
    assert.equal(level({ memUsedBytes: 12 * GB }, 1), "ok"); // 4 GB available
    assert.equal(level({ memUsedBytes: 12.5 * GB }, 1), "warn"); // 3.5
    assert.equal(level({ memUsedBytes: 13.5 * GB }, 1), "warn"); // 2.5
    assert.equal(level({ memUsedBytes: 14 * GB }, 1), "bad"); // 2
    const mem = dialsFor(reading({ memUsedBytes: 11 * GB, memPercent: 69 }))[1];
    assert.equal(mem.value, "69%");
    assert.equal(mem.sub, "5.0 GB free");
    // The scale's zones sit where 4 and 2.5 GB available would be.
    assert.deepEqual(mem.zones, [75, 84.375]);
  });
  it("DISK: amber over 80 % used, red over 90 %", () => {
    assert.equal(level({ diskPercent: 80 }, 2), "ok");
    assert.equal(level({ diskPercent: 85 }, 2), "warn");
    assert.equal(level({ diskPercent: 95 }, 2), "bad");
    assert.equal(dialsFor(reading())[2].sub, "70 GB free");
  });
  it("no data: greyed, a dash, no needle", () => {
    for (const d of dialsFor(null)) {
      assert.equal(d.level, "none");
      assert.equal(d.value, "—");
      assert.equal(d.pct, null);
    }
  });
  it("the key (repaint trigger) changes only with what's shown", () => {
    const a = dialsFor(reading({ cpuPercent: 20.2 })).map(dialKey).join("~");
    assert.equal(dialsFor(reading({ cpuPercent: 19.9 })).map(dialKey).join("~"), a);
    assert.notEqual(dialsFor(reading({ cpuPercent: 22 })).map(dialKey).join("~"), a);
  });
});

describe("per-core bars", () => {
  it("one bar per core, levels by the CPU dial's thresholds", () => {
    const bars = coreBarsFor(reading({ cpuPerCore: [0, 70, 71, 90, 91, 100, 140, -5] }));
    assert.deepEqual(
      bars.map((b) => b.level),
      ["ok", "ok", "warn", "warn", "bad", "bad", "bad", "ok"],
    );
    // Fills are clamped to 0–100.
    assert.deepEqual(
      bars.map((b) => b.pct),
      [0, 70, 71, 90, 91, 100, 100, 0],
    );
  });
  it("no per-core data: grey bars, as many as the cores, else as last shown", () => {
    const first = coreBarsFor(reading({ cpuCores: 16, cpuPerCore: null }));
    assert.equal(first.length, 16);
    assert.ok(first.every((b) => b.pct === null && b.level === "none"));
    assert.equal(coreBarsFor(null).length, DEFAULT_CORES);
    assert.equal(coreBarsFor(null, 24).length, 24);
    // A broken array counts as no data.
    assert.ok(coreBarsFor(reading({ cpuCores: 4, cpuPerCore: [10, Number.NaN] })).every((b) => b.level === "none"));
    assert.equal(coreBarsFor(reading({ cpuPerCore: [] }), 8).length, 8);
  });
  it("the key (repaint trigger) changes only with whole percents or levels", () => {
    const k = coreBarsKey(coreBarsFor(reading({ cpuPerCore: [20.2, 50] })));
    assert.equal(coreBarsKey(coreBarsFor(reading({ cpuPerCore: [19.9, 50.4] }))), k);
    assert.notEqual(coreBarsKey(coreBarsFor(reading({ cpuPerCore: [21, 50] }))), k);
    assert.notEqual(coreBarsKey(coreBarsFor(null, 2)), k);
  });
});

describe("per-core layout", () => {
  const inside = (c: { x: number; y: number; w: number; h: number }) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9;
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
  it("up to 16 cores: one row, left to right, same width", () => {
    const cells = coreCells(16);
    assert.equal(cells.length, 16);
    assert.ok(cells.every((c) => c.y === 0 && c.h === 1));
    for (let i = 1; i < 16; i++) assert.ok(cells[i].x > cells[i - 1].x);
    assert.ok(cells.every((c) => Math.abs(c.w - cells[0].w) < 1e-12));
    assert.equal(coreCells(4).length, 4);
    assert.ok(coreCells(4)[0].w > cells[0].w);
  });
  it("more than 16 wrap into balanced rows; a short last row stays left-aligned", () => {
    const rows = (n: number) => new Set(coreCells(n).map((c) => c.y)).size;
    assert.equal(rows(17), 2);
    assert.equal(rows(32), 2);
    assert.equal(rows(33), 3);
    assert.equal(rows(64), 4);
    // 20 cores: 2 rows of 10, not 16 + 4.
    const twenty = coreCells(20);
    assert.equal(twenty.filter((c) => c.y === twenty[0].y).length, 10);
    // 17: 9 + 8, the second row starting under the first.
    const seventeen = coreCells(17);
    assert.equal(seventeen.filter((c) => c.y === seventeen[0].y).length, 9);
    assert.equal(seventeen[9].x, seventeen[0].x);
    assert.ok(seventeen[9].y > seventeen[0].y);
  });
  it("every bar inside the strip, none overlapping, for any count", () => {
    for (const n of [1, 2, 7, 16, 17, 24, 32, 48, 96, 128]) {
      const cells = coreCells(n);
      assert.equal(cells.length, n);
      assert.ok(cells.every(inside), `n=${n}`);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(!overlap(cells[i], cells[j]), `n=${n} ${i}/${j}`);
    }
    assert.deepEqual(coreCells(0), []);
  });
});

describe("easing to a new reading", () => {
  it("eases out from the old value to the new over EASE_MS, then holds", () => {
    const e = retarget(retarget(null, 20, 0, 0, true), 80, 1000);
    assert.equal(easedAt(e, 1000), 20);
    const mid = easedAt(e, 1000 + EASE_MS / 2);
    // Ease-out: past the halfway value at half the time.
    assert.ok(mid > 50 && mid < 80);
    assert.equal(easedAt(e, 1000 + EASE_MS), 80);
    assert.equal(easedAt(e, 1000 + 10 * EASE_MS), 80);
    assert.ok(easing(e, 1000 + EASE_MS - 1));
    assert.ok(!easing(e, 1000 + EASE_MS));
  });
  it("a reading mid-ease retargets from where the needle is", () => {
    const a = retarget(retarget(null, 0, 0, 0, true), 100, 0);
    const at = easedAt(a, 300);
    const b = retarget(a, 10, 300);
    assert.equal(easedAt(b, 300), at);
    assert.equal(easedAt(b, 300 + EASE_MS), 10);
  });
  it("the same target changes nothing; the first reading starts from `start`; reduced motion jumps", () => {
    const a = retarget(null, 40, 0);
    assert.equal(easedAt(a, 0), 0);
    assert.equal(retarget(a, 40, 500), a);
    const snap = retarget(a, 70, 100, 0, true);
    assert.equal(easedAt(snap, 100), 70);
    assert.ok(!easing(snap, 100));
  });
  it("the face repaints only when its rim, scale or text changes, not with the value", () => {
    const k = faceKey(dialsFor(reading({ cpuPercent: 20 }))[0]);
    assert.equal(faceKey(dialsFor(reading({ cpuPercent: 60 }))[0]), k);
    assert.notEqual(faceKey(dialsFor(reading({ cpuPercent: 75 }))[0]), k);
    assert.notEqual(faceKey(dialsFor(null)[0]), k);
  });
});
