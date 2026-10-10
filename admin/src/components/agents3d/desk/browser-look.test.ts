import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrowserSession } from "@/lib/browsers";

import { browserLook, lookKey, seatBrowsers } from "./browser-look";

const session = (o: Partial<BrowserSession>): BrowserSession => ({
  session: "Tom",
  agent: "Tom",
  unowned: false,
  running: true,
  cpuPercent: 10,
  memMB: 300,
  procs: 8,
  startedAt: "2026-10-10T02:00:00Z",
  page: { title: "Agents City", host: "localhost:7000" },
  ...o,
});
const cast = [
  { key: "k-tom", name: "Tom" },
  { key: "k-ramona", name: "Ramona" },
];

describe("seatBrowsers", () => {
  it("matches sessions to seated agents by name, case-insensitive", () => {
    const { byAgent, unowned } = seatBrowsers(cast, [session({ session: "ramona", agent: "RAMONA" }), session({})]);
    assert.deepEqual([...byAgent.keys()].sort(), ["k-ramona", "k-tom"]);
    assert.equal(unowned.length, 0);
  });
  it("unowned: 'default', no live agent, or an agent not at the table; stopped browsers are left out", () => {
    const { byAgent, unowned } = seatBrowsers(cast, [
      session({ session: "default", agent: null, unowned: true }),
      session({ session: "Ghost", agent: null, unowned: true }),
      session({ session: "Bob", agent: "Bob" }),
      session({ session: "Tom", running: false }),
    ]);
    assert.equal(byAgent.size, 0);
    assert.deepEqual(
      unowned.map((s) => s.session),
      ["Bob", "default", "Ghost"],
    );
  });
  it("an agent's sessions busiest first; a session named for nobody falls back to its own name", () => {
    const { byAgent } = seatBrowsers(cast, [session({ session: "tom", agent: null, cpuPercent: 5 }), session({ session: "Tom-2", agent: "Tom", cpuPercent: 80 })]);
    assert.deepEqual(
      byAgent.get("k-tom")!.map((s) => s.session),
      ["Tom-2", "tom"],
    );
  });
});

describe("browserLook", () => {
  it("CPU: amber over 30 %, red over a whole core; the bar is full at two cores", () => {
    assert.equal(browserLook(session({ cpuPercent: 30 }), true).level, "ok");
    assert.equal(browserLook(session({ cpuPercent: 45 }), true).level, "warn");
    assert.equal(browserLook(session({ cpuPercent: 101 }), true).level, "bad");
    assert.equal(browserLook(session({ cpuPercent: 100 }), true).cpuFill, 0.5);
    assert.equal(browserLook(session({ cpuPercent: 450 }), true).cpuFill, 1);
    const first = browserLook(session({ cpuPercent: null }), true);
    assert.equal(first.level, "none");
    assert.equal(first.cpuText, "CPU …");
  });
  it("shows the host and title, marks unowned, and repaints only on a visible change", () => {
    const l = browserLook(session({ cpuPercent: 44.9 }), true);
    assert.equal(l.host, "localhost:7000");
    assert.equal(l.cpuText, "45% CPU");
    assert.equal(browserLook(session({ session: "default" }), false).bar, "unowned · default");
    assert.equal(browserLook(session({ page: null }), true).host, "no page");
    const k = lookKey(l, "#f00");
    assert.equal(lookKey(browserLook(session({ cpuPercent: 45.2, memMB: 999 }), true), "#f00"), k);
    assert.notEqual(lookKey(browserLook(session({ cpuPercent: 46 }), true), "#f00"), k);
    assert.notEqual(lookKey(l, "#0f0"), k);
  });
});
