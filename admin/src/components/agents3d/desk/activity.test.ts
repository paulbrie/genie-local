import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TLAgent } from "@/lib/agents3d-timeline";
import type { CommsNode } from "@/lib/claude-comms-parse";

import { asleepAt, doingAt, gazeAt, headCue, SLEEP_AFTER_MS } from "./activity";
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
