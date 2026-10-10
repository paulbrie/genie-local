import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dialKey, dialsFor, type StatsReading } from "./gauge-levels";

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
