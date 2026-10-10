import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { descendants, parseProcPidStat, type ProcStat, treeCpuPercent, treeMemMB } from "./proc-tree";

// /proc/<pid>/stat lines: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
// utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss …
const line = (pid: number, comm: string, ppid: number, utime: number, stime: number, start: number, rss: number) =>
  `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 12 0 ${start} 123456789 ${rss} 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0`;

const table = (lines: string[]) =>
  new Map(lines.map((l) => parseProcPidStat(Number(l.split(" ")[0]), l)!).map((p) => [p.pid, p] as const));

// daemon 100 → chrome 200 → renderer 201, gpu 202 → utility 203; an unrelated 300.
const T0 = table([
  line(100, "agent-browser-l", 1, 50, 10, 1000, 2000),
  line(200, "chrome", 100, 400, 100, 2000, 50000),
  line(201, "chrome) (renderer", 200, 300, 50, 2100, 30000),
  line(202, "chrome", 200, 100, 0, 2100, 20000),
  line(300, "bash", 1, 5, 5, 500, 1000),
]);

describe("parseProcPidStat", () => {
  it("reads ppid, utime+stime, start and rss, even with ') (' in the name", () => {
    assert.deepEqual(T0.get(201), { pid: 201, ppid: 200, ticks: 350, startTicks: 2100, rssPages: 30000 });
  });
  it("is null for what isn't a stat line", () => {
    assert.equal(parseProcPidStat(1, ""), null);
    assert.equal(parseProcPidStat(1, "1 (x) S"), null);
  });
});

describe("descendants", () => {
  it("is the whole tree under a root, not the root, nothing else", () => {
    const t1 = new Map(T0);
    t1.set(203, parseProcPidStat(203, line(203, "chrome", 202, 0, 0, 2200, 100))!);
    assert.deepEqual(descendants(t1.values(), 100), [200, 201, 202, 203]);
    assert.deepEqual(descendants(T0.values(), 300), []);
  });
});

describe("treeCpuPercent", () => {
  const pids = [200, 201, 202];
  const prev = { uptime: 30, ticks: new Map([...T0].map(([pid, p]) => [pid, p.ticks])) };
  it("is the tree's ticks over the time between readings (100 = one core)", () => {
    // 2 s later: chrome +100, renderer +150, gpu +50 → 300 ticks = 3 s of CPU in 2 s = 150%
    const t1 = table([
      line(100, "agent-browser-l", 1, 50, 10, 1000, 2000),
      line(200, "chrome", 100, 450, 150, 2000, 50000),
      line(201, "chrome) (renderer", 200, 400, 100, 2100, 30000),
      line(202, "chrome", 200, 150, 0, 2100, 20000),
    ]);
    assert.equal(treeCpuPercent(pids, t1, 32, prev), 150);
  });
  it("counts a process started since the last reading in full, and drops one that ended", () => {
    const t1 = table([
      line(200, "chrome", 100, 400, 100, 2000, 50000), // idle
      line(204, "chrome", 200, 40, 10, 3050, 1000), // born at 30.5 s: 50 ticks
    ]);
    assert.equal(treeCpuPercent([200, 204], t1, 32, prev), 25);
  });
  it("skips a reused pid (older than the last reading, never seen) and never goes negative", () => {
    const t1 = table([line(205, "chrome", 200, 900, 0, 100, 1), line(200, "chrome", 100, 300, 0, 2000, 1)]);
    assert.equal(treeCpuPercent([200, 205], t1, 32, prev), 0);
  });
  it("is null without a previous reading or under half a second after it", () => {
    assert.equal(treeCpuPercent(pids, T0, 30, null), null);
    assert.equal(treeCpuPercent(pids, T0, 30.2, prev), null);
  });
});

describe("treeMemMB", () => {
  it("sums the tree's resident pages", () => {
    assert.equal(treeMemMB([200, 201, 202, 999], T0 as Map<number, ProcStat>), Math.round((100000 * 4096) / 1048576));
  });
});
