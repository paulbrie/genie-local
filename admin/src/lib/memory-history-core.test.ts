import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memoryDistribution, projectTotals } from "./memory-history-core";

const MB = 1024 * 1024;
const line = (t: number, mu: number, pm: Record<string, number>, pa: Record<string, number> = {}) => JSON.stringify({ t, cpu: 1, mem: 1, mu, mt: 1000 * MB, pm, pa });

describe("memoryDistribution", () => {
  it("averages each bucket: what's used, each project and its agents, leaving out lines without projects", () => {
    const now = 10_000;
    const raw = [
      JSON.stringify({ t: 1000, mu: 5, mt: 9 }),
      line(1000, 100 * MB, { a: 10, b: 20 }, { a: 4 }),
      line(2000, 300 * MB, { a: 30 }),
      line(9000, 50 * MB, { b: 6 }),
      "not json",
      line(50_000, 1, { a: 1 }),
    ].join("\n");
    const d = memoryDistribution(raw, 10_000, now, 2);
    assert.equal(d.bucketMs, 5000);
    assert.equal(d.totalBytes, 1000 * MB);
    assert.equal(d.points.length, 2);
    assert.deepEqual(d.points[0], { t: 1500, used: 200 * MB, projects: { a: 20 * MB, b: 10 * MB }, agents: { a: 2 * MB } });
    assert.deepEqual(d.points[1], { t: 9000, used: 50 * MB, projects: { b: 6 * MB }, agents: {} });
  });
  it("is empty with nothing in the period", () => {
    assert.deepEqual(memoryDistribution("", 1000, 5000).points, []);
  });
});

describe("projectTotals", () => {
  it("is each project's average and peak, its agents counted, the biggest first", () => {
    const t = projectTotals([
      { t: 1, used: 0, projects: { a: 10, b: 50 }, agents: { a: 30 } },
      { t: 2, used: 0, projects: { a: 30 }, agents: {} },
    ]);
    assert.deepEqual(t, [
      { slug: "a", avg: 20, agentsAvg: 15, peak: 40 },
      { slug: "b", avg: 25, agentsAvg: 0, peak: 50 },
    ]);
  });
});
