// node --test tools/local-genie-mcp
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { LEASE_MINUTES, MAX_LEASE_MINUTES, claimState, claimable, leaseMinutes } from "./claims.mjs";

const now = Date.parse("2026-11-20T12:00:00Z");
const soon = "2026-11-20T12:10:00Z";
const past = "2026-11-20T11:50:00Z";
const task = (o) => ({ id: 1, status: "open", assignee: null, claimed_until: null, ...o });

describe("claimState", () => {
  it("frees a task nobody holds, and never one that's done", () => {
    assert.equal(claimState(task({}), "Bob", new Set(), now), "free");
    assert.equal(claimState(task({ status: "done" }), "Bob", new Set(), now), "done");
    assert.equal(claimState(task({ status: "done", assignee: "Bob" }), "Bob", new Set(["Bob"]), now), "done");
  });
  it("knows the caller's own", () => {
    assert.equal(claimState(task({ assignee: "Bob", status: "in_progress" }), "Bob", new Set(), now), "mine");
  });
  it("holds a task for an agent whose terminal is open, lease or not", () => {
    assert.equal(claimState(task({ assignee: "Ada", claimed_until: past }), "Bob", new Set(["Ada"]), now), "held");
    assert.equal(claimState(task({ assignee: "Ada" }), "Bob", new Set(["Ada"]), now), "held");
  });
  it("holds one for an agent without a terminal while its lease lasts, and frees it after", () => {
    assert.equal(claimState(task({ assignee: "ci", claimed_until: soon }), "Bob", new Set(), now), "held");
    assert.equal(claimState(task({ assignee: "ci", claimed_until: past }), "Bob", new Set(), now), "free");
    // delegated to a terminal since closed, no lease: free
    assert.equal(claimState(task({ assignee: "Ada" }), "Bob", new Set(), now), "free");
  });
  it("gives an agent with no name nothing of its own", () => {
    assert.equal(claimState(task({ assignee: "Ada", claimed_until: soon }), null, new Set(), now), "held");
  });
});

describe("claimable", () => {
  it("offers the open tasks in order first, then the ones in progress whose agent went away", () => {
    const tasks = [
      task({ id: 1, status: "in_progress", assignee: "gone", claimed_until: past }),
      task({ id: 2 }),
      task({ id: 3, assignee: "Ada" }),
      task({ id: 4, status: "done" }),
      task({ id: 5 }),
      task({ id: 6, status: "in_progress", assignee: "Bob" }),
    ];
    assert.deepEqual(claimable(tasks, "Bob", new Set(["Ada"]), now).map((t) => t.id), [2, 5, 1]);
  });
});

describe("leaseMinutes", () => {
  it("defaults, rounds and keeps a lease within bounds", () => {
    assert.equal(leaseMinutes(undefined), LEASE_MINUTES);
    assert.equal(leaseMinutes(0), 1);
    assert.equal(leaseMinutes(12.4), 12);
    assert.equal(leaseMinutes(100_000), MAX_LEASE_MINUTES);
  });
});
