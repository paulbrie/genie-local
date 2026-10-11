import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fileKey, snapshotAt, type Timeline, type TLAgent } from "@/lib/agents3d-timeline";
import type { CommsNode } from "@/lib/claude-comms-parse";
import { actsOf, cityOf, CITY_SWITCH_MS, litKey, opsModel, SCREEN_N } from "./model";

const T = Date.parse("2026-10-10T12:00:00Z");
const node = (key: string, guest = false): CommsNode => ({
  key, sessionId: null, shortId: key, name: key, names: [], cwd: "/r", gitBranch: null, live: true, status: "idle", asking: null,
  tmux: null, sockets: [], role: "peer", sent: 0, received: 0, lastActivity: null, sessions: [], guest,
});
const agent = (key: string, events: [number, string, string | null][], guest = false): TLAgent => ({
  key, name: key, role: "peer", color: "#123456", node: node(key, guest), repo: "/r", cwdRel: "",
  events: events.map(([ago, tool, path]) => ({ t: new Date(T - ago).toISOString(), ms: T - ago, tool, repo: "/r", path })).sort((x, y) => x.ms - y.ms),
});
const tl = (agents: TLAgent[], more: Partial<Timeline> = {}): Timeline => ({
  start: T - 3_600_000, end: T, agents, byKey: new Map(agents.map((a) => [a.key, a])), messages: [], claims: [], edits: [], commits: [], tasks: [],
  files: new Set(["a.ts", "b.ts", "c.ts"].map((p) => fileKey("/r", p))), repos: [], ...more,
});

describe("opsModel (T163)", () => {
  it("lights files touched in the last 5 minutes (an edit over a read), not older ones; guests left out", () => {
    const t = tl([agent("Bob", [[60_000, "Read", "a.ts"], [30_000, "Edit", "a.ts"], [20_000, "Read", "b.ts"], [10 * 60_000, "Edit", "c.ts"]]), agent("guest", [[1000, "Edit", "c.ts"]], true)]);
    const m = opsModel(t, snapshotAt(t, T, false));
    assert.deepEqual(m.agents.map((a) => a.key), ["Bob"]);
    assert.deepEqual([...m.lit].map(([k, v]) => [k.split("\n")[1], v.kind, v.by]).sort(), [["a.ts", "edit", "Bob"], ["b.ts", "read", "Bob"]]);
  });
  it("marks a file claimed by two agents as a clash, by one as held", () => {
    const claims = [
      { ms: T - 5000, node: "Bob", action: "claim" as const, fileKey: fileKey("/r", "a.ts"), path: "a.ts", guessed: false },
      { ms: T - 4000, node: "Ann", action: "claim" as const, fileKey: fileKey("/r", "a.ts"), path: "a.ts", guessed: false },
      { ms: T - 3000, node: "Ann", action: "claim" as const, fileKey: fileKey("/r", "b.ts"), path: "b.ts", guessed: false },
    ];
    const t = tl([agent("Bob", []), agent("Ann", [])], { claims });
    const m = opsModel(t, snapshotAt(t, T, false));
    assert.equal(m.lit.get(fileKey("/r", "a.ts"))?.kind, "clash");
    assert.deepEqual(m.lit.get(fileKey("/r", "b.ts")), { kind: "held", by: "Ann" });
  });
  it("is the same between the clock's ticks when nothing happens (nothing to draw)", () => {
    const t = tl([agent("Bob", [[10_000, "Edit", "a.ts"], [15_000, "Bash", null]])]);
    const at = (dt: number) => opsModel(t, snapshotAt(t, T + dt, false));
    const a = at(0), b = at(250), c = at(750);
    assert.equal(litKey(a.lit), litKey(b.lit));
    assert.equal(litKey(b.lit), litKey(c.lit));
    assert.deepEqual(a.agents, b.agents);
    assert.equal(a.t, c.t);
  });
  it("counts the cards' activity in 3-minute steps over the last hour", () => {
    // (steps on the clock's 3-minute marks: at 12:00 the newest step is 12:00–12:03, so the last minute counts in the one before)
    const t = tl([agent("Bob", [[10_000, "Edit", "a.ts"], [20_000, "Read", "a.ts"], [50 * 60_000, "Bash", null], [65 * 60_000, "Bash", null]])]);
    const s = opsModel(t, snapshotAt(t, T, false)).agents[0].spark;
    assert.equal(s.length, 20);
    assert.equal(s[18], 2);
    assert.equal(s.reduce((x, y) => x + y, 0), 3);
  });
  it("curves (T201): a file edited or read in the last 90 s (an edit over a read), fading with age; claimed files too", () => {
    const claims = [{ ms: T - 5000, node: "Bob", action: "claim" as const, fileKey: fileKey("/r", "c.ts"), path: "c.ts", guessed: false }];
    const t = tl([agent("Bob", [[5_000, "Edit", "a.ts"], [40_000, "Read", "a.ts"], [60_000, "Read", "b.ts"], [200_000, "Edit", "c.ts"]])], { claims });
    const links = opsModel(t, snapshotAt(t, T, false)).links.map((l) => [l.file.split("\n")[1], l.kind, l.fade]).sort();
    assert.deepEqual(links, [["a.ts", "edit", 1], ["b.ts", "read", Math.round((1 - 60 / 90) * 9) / 9], ["c.ts", "claim", 1]]);
  });
  it("the belts (T201, T204): each repo's newest 15 commits of named agents, labelled by task id (else the short hash), pushed by then", () => {
    const commits = [
      ...Array.from({ length: 3 }, (_, i) => ({ hash: `s${i}`.padEnd(40, "0"), abbrev: `s${i}`, subject: `other ${i}`, repo: "/s", node: "Bob", ms: T - (40 - i) * 1000, pushedMs: null, remote: false })),
      ...Array.from({ length: 25 }, (_, i) => ({
        hash: `h${i}`.padEnd(40, "0"), abbrev: `h${i}`, subject: i === 24 ? "admin: desks (T201)" : `commit ${i}`, repo: "/r", node: i === 23 ? "guest" : "Bob",
        ms: T - (25 - i) * 1000, pushedMs: i === 24 ? T + 1000 : i === 22 ? T - 100 : null, remote: false,
      })),
    ];
    const t = tl([agent("Bob", []), agent("guest", [], true)], { commits });
    const m = opsModel(t, snapshotAt(t, T, false));
    assert.equal(m.commits.filter((c) => c.repo === "/r").length, 15);
    assert.equal(m.commits.filter((c) => c.repo === "/s").length, 3, "another repo's older commits kept: its own 15");
    assert.ok(!m.commits.some((c) => c.by === "guest"));
    const last = m.commits[m.commits.length - 1];
    assert.deepEqual([last.label, last.pushed], ["T201", false]);
    assert.deepEqual([m.commits.find((c) => c.hash.startsWith("h22"))?.pushed, m.commits.find((c) => c.repo === "/r")?.label, m.commits[0].label], [true, "h9", "s0"]);
  });

  it("an agent's city (T204c): its latest repo once it has worked there 2 min, else the one before; no touches: its home", () => {
    const at = (ago: number, repo: string) => ({ ms: T - ago, repo });
    assert.equal(cityOf([at(60_000, "/a"), at(30_000, "/b")], T, "/h"), "/a", "30 s in /b: still /a");
    assert.equal(cityOf([at(10 * 60_000, "/a"), at(3 * 60_000, "/b"), at(10_000, "/b")], T, "/h"), "/b", "3 min in /b: /b");
    assert.equal(cityOf([at(10_000, "/b")], T, "/h"), "/b", "only ever /b: /b at once");
    assert.equal(cityOf([], T, "/h"), "/h");
    assert.equal(cityOf([at(-5000, "/z")], T, null), null, "a touch after t doesn't count");
    assert.equal(CITY_SWITCH_MS, 120_000);
  });
  it("an agent's screen (T204g): its last 6 actions up to t, oldest first; none recorded, none", () => {
    const acts = Array.from({ length: 12 }, (_, i) => ({ kind: (["edit", "read", "bash", "other"] as const)[i % 4], at: new Date(T - (12 - i) * 1000).toISOString(), len: i * 10 }));
    const a = actsOf(acts, T);
    assert.equal(a.length, SCREEN_N);
    assert.deepEqual(a.map((x) => x.len), [60, 70, 80, 90, 100, 110]);
    assert.equal(actsOf([...acts, { kind: "edit", at: new Date(T + 60_000).toISOString(), len: 5 }], T).length, SCREEN_N, "a later one (replay) not shown");
    assert.deepEqual(actsOf(undefined, T), []);
  });
  it("the manager and the messages' fade (T204e): by the recipe's role, else the one named Alice; a message 1 new, fading over 2 min", () => {
    const msg = (id: string, ago: number) => ({ id, ms: T - ago, from: "Alice", to: "Bob", tag: "TASK" as const, color: "#fff", label: id, text: id, cc: [] as string[] });
    const t = tl([agent("Bob", []), agent("Alice", [])], { messages: [msg("m2", 60_000), msg("m1", 0)] as never });
    const m = opsModel(t, snapshotAt(t, T, false));
    assert.deepEqual(m.agents.map((a) => [a.key, !!a.manager]), [["Bob", false], ["Alice", true]]);
    assert.deepEqual(m.msgs.map((x) => [x.id, x.fade]), [["m2", Math.round(0.5 * 9) / 9], ["m1", 1]]);
  });
});
