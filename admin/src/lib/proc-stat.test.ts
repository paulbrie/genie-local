import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coreBusyPercent, parseProcStat } from "./proc-stat";

// A trimmed /proc/stat: the total line, 2 cores (guest columns included), and the lines after.
const A = `cpu  4000 0 1000 13000 200 0 50 0 0 0
cpu0 2000 0 500 7000 100 0 0 0 0 0
cpu1 2000 0 500 6000 100 0 50 0 300 0
intr 123456 0 0
ctxt 987654
btime 1791590000
procs_running 3
`;
// 1 s later (100 jiffies per core): cpu0 50 busy of 100, cpu1 100 busy of 100.
const B = `cpu  4150 0 1000 13050 200 0 50 0 0 0
cpu1 2100 0 500 6000 100 0 50 0 300 0
cpu0 2050 0 500 7050 100 0 0 0 0 0
intr 123999 0 0
`;

describe("parseProcStat", () => {
  it("reads each core's busy and total jiffies, in core order, without the total line", () => {
    assert.deepEqual(parseProcStat(A), [
      { busy: 2500, total: 9600 },
      { busy: 2550, total: 8650 },
    ]);
    // cores listed out of order still come back as cpu0, cpu1
    assert.deepEqual(parseProcStat(B)[0], { busy: 2550, total: 9700 });
  });
  it("counts iowait as idle and leaves guest time out (it is already in user)", () => {
    const [c] = parseProcStat("cpu0 10 0 0 80 10 0 0 0 7 0\n");
    assert.deepEqual(c, { busy: 10, total: 100 });
  });
  it("skips what isn't a core line", () => {
    assert.deepEqual(parseProcStat(""), []);
    assert.deepEqual(parseProcStat("cpu  1 2 3 4\nintr 5\ncpux 1 2 3 4\ncpu3 a b c d\n"), []);
  });
});

describe("coreBusyPercent", () => {
  it("is each core's busy share of the time between two readings", () => {
    assert.deepEqual(coreBusyPercent(parseProcStat(A), parseProcStat(B)), [50, 100]);
  });
  it("rounds to one decimal and stays within 0–100", () => {
    const p = [{ busy: 0, total: 0 }];
    assert.deepEqual(coreBusyPercent(p, [{ busy: 1, total: 3 }]), [33.3]);
    assert.deepEqual(coreBusyPercent(p, [{ busy: 5, total: 3 }]), [100]);
    assert.deepEqual(coreBusyPercent([{ busy: 5, total: 10 }], [{ busy: 4, total: 20 }]), [0]);
  });
  it("is 0 for a core whose counters didn't move", () => {
    assert.deepEqual(coreBusyPercent([{ busy: 5, total: 10 }], [{ busy: 5, total: 10 }]), [0]);
  });
  it("is null without a previous reading or when the core count changed", () => {
    assert.equal(coreBusyPercent([], parseProcStat(A)), null);
    assert.equal(coreBusyPercent(parseProcStat(A), parseProcStat(A).slice(0, 1)), null);
  });
});
