import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TLAgent } from "@/lib/agents3d-timeline";
import type { CommsNode } from "@/lib/claude-comms-parse";

import { asksUser, asleepAt, doingAt, gazeAt, headCue, SLEEP_AFTER_MS, WAVE_MS, waveAt } from "./activity";
import { idlePose } from "./poses";

const T0 = 1_700_000_000_000;
const S = 1000;

function agent(eventsAt: number[], node: Partial<CommsNode> = {}): TLAgent {
  return {
    key: "s:tom",
    name: "Tom",
    role: "peer",
    color: "#fff",
    node: { key: "s:tom", name: "Tom", live: true, status: "idle", guest: false, ...node } as CommsNode,
    repo: null,
    cwdRel: "",
    events: eventsAt.map((ms) => ({ ms, tool: "Edit", repo: "admin", path: "src/a.ts" }) as TLAgent["events"][number]),
  };
}

/** The resting posture the Table picks, over a minute of wall clock (catches anything cycling in). */
function posesOver(a: TLAgent, t: number): Set<string> {
  const d = doingAt(a, t, true);
  const out = new Set<string>();
  for (let ms = 0; ms < 60 * S; ms += S) out.add(d.doing === "idle" || d.doing === "nap" ? idlePose(7, ms, d.doing === "nap", d.asleep) : d.doing);
  return out;
}

describe("sleeping after SLEEP_AFTER_MS idle", () => {
  it("is 30 s", () => {
    assert.equal(SLEEP_AFTER_MS, 30 * S);
  });
  it("idle 29 s: not asleep, still at work", () => {
    const a = agent([T0]);
    assert.equal(asleepAt(a, T0 + 29 * S, true), false);
    const d = doingAt(a, T0 + 29 * S, true);
    assert.equal(d.asleep, false);
    assert.equal(d.doing, "type");
  });
  it("idle 31 s: asleep, holding the nap with nothing cycling in", () => {
    const a = agent([T0]);
    const d = doingAt(a, T0 + 31 * S, true);
    assert.equal(d.asleep, true);
    assert.equal(d.doing, "nap");
    assert.deepEqual([...posesOver(a, T0 + 31 * S)], ["nap"]);
    // Still asleep long after (no idle variants once past the old nap time either).
    assert.deepEqual([...posesOver(a, T0 + 20 * 60 * S)], ["nap"]);
  });
  it("new activity wakes it at once", () => {
    const a = agent([T0, T0 + 40 * S]);
    assert.equal(asleepAt(a, T0 + 39 * S, true), true);
    const d = doingAt(a, T0 + 40 * S, true);
    assert.equal(d.asleep, false);
    assert.equal(d.doing, "type");
  });
  it("live and busy (thinking between tool calls): awake", () => {
    const a = agent([T0], { status: "busy" });
    assert.equal(asleepAt(a, T0 + 31 * S, true), false);
    // A replay has no status: the gap alone counts.
    assert.equal(asleepAt(a, T0 + 31 * S, false), true);
  });
  it("guests and ended sessions keep the idle → nap cycle", () => {
    for (const a of [agent([T0], { guest: true }), agent([T0], { live: false, status: null })]) {
      assert.equal(asleepAt(a, T0 + 31 * S, true), false);
      assert.equal(doingAt(a, T0 + 2 * 60 * S, true).doing, "idle");
      assert.ok(posesOver(a, T0 + 2 * 60 * S).size > 1);
    }
  });
});

describe("waiting for its user (status waiting)", () => {
  it("stays awake, shows ?, looks at the camera, however long it waits", () => {
    const a = agent([T0], { status: "waiting" });
    for (const t of [T0 + 31 * S, T0 + 20 * 60 * S]) {
      const d = doingAt(a, t, true);
      assert.equal(d.asleep, false);
      assert.equal(asleepAt(a, t, true), false);
      assert.equal(d.doing, "wait");
      assert.equal(headCue(d.doing, null, false), "?");
      assert.equal(gazeAt(d.doing), "camera");
    }
  });
  it("acting again (busy, a new tool call) drops both at once", () => {
    const a = agent([T0, T0 + 60 * S], { status: "busy" });
    const d = doingAt(a, T0 + 60 * S, true);
    assert.equal(d.doing, "type");
    assert.equal(headCue(d.doing, null, false), null);
    assert.equal(gazeAt(d.doing), null);
  });
  it("only live: a replay has no status to go by", () => {
    assert.notEqual(doingAt(agent([T0], { status: "waiting" }), T0 + 5 * S, false).doing, "wait");
  });
  it("the other signs are unchanged", () => {
    assert.equal(headCue("type", "blocked", false), "?");
    assert.equal(headCue("nap", null, true), "z z Z");
    assert.equal(headCue("idle", null, false), null);
    assert.equal(headCue("wait", "carry", false), null);
  });
});

describe("waving to the user while waiting", () => {
  const since = 50_000;
  /** The waves' start times over `ms` of waiting, sampled every 10 ms. */
  const starts = (seed: number, ms: number) => {
    const out: number[] = [];
    let was = false;
    for (let t = since; t < since + ms; t += 10) {
      const w = waveAt(seed, since, t).waving;
      if (w && !was) out.push(t - since);
      was = w;
    }
    return out;
  };
  it("waves at once, for WAVE_MS, then holds still", () => {
    assert.equal(waveAt(7, since, since).waving, true);
    assert.equal(waveAt(7, since, since + WAVE_MS - 1).waving, true);
    assert.equal(waveAt(7, since, since + WAVE_MS).waving, false);
    assert.equal(waveAt(7, since, since).inMs, WAVE_MS);
  });
  it("again every 6–8 s, repeatable, different per agent", () => {
    const a = starts(7, 60_000);
    assert.equal(a[0], 0);
    for (let i = 1; i < a.length; i++) assert.ok(a[i] - a[i - 1] >= 6000 && a[i] - a[i - 1] <= 8010, `gap ${a[i] - a[i - 1]}`);
    assert.ok(a.length >= 8 && a.length <= 11);
    assert.deepEqual(starts(7, 60_000), a);
    assert.notDeepEqual(starts(8, 60_000), a);
  });
  it("tells when it next changes, so nothing is drawn in between", () => {
    const t = since + WAVE_MS + 100;
    const w = waveAt(7, since, t);
    assert.equal(w.waving, false);
    assert.equal(waveAt(7, since, t + w.inMs).waving, true);
    assert.equal(waveAt(7, since, t + w.inMs - 1).waving, false);
  });
  it("a wait that hasn't started yet doesn't wave", () => {
    assert.deepEqual(waveAt(7, since, since - 500), { waving: false, inMs: 500 });
  });
});

describe("question or permission prompt", () => {
  it("waves only for a question (AskUserQuestion as the last call while waiting)", () => {
    assert.equal(asksUser("wait", "AskUserQuestion"), true);
    assert.equal(asksUser("wait", "Bash"), false);
    assert.equal(asksUser("wait", null), false);
    assert.equal(asksUser("idle", "AskUserQuestion"), false);
  });
  it("the wait's last call comes through doingAt, and acting ends it", () => {
    const a = agent([T0 - 5 * S]);
    a.events[0] = { ...a.events[0], tool: "AskUserQuestion" };
    const waiting = { ...a, node: { ...a.node, status: "waiting" as const } };
    const d = doingAt(waiting, T0, true);
    assert.equal(asksUser(d.doing, d.tool), true);
    const acted = doingAt({ ...waiting, node: { ...waiting.node, status: "busy" as const } }, T0, true);
    assert.equal(asksUser(acted.doing, acted.tool), false);
  });
});
