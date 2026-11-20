import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { delegationLine, EFFORTS, isEffort, restoreEffortDefault } from "./effort";

describe("effort", () => {
  it("knows Claude's levels, and nothing else", () => {
    assert.deepEqual([...EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
    assert.ok(isEffort("xhigh"));
    assert.ok(!isEffort("auto"));
    assert.ok(!isEffort(3));
  });

  it("says in the thread how a ticket was delegated", () => {
    assert.equal(delegationLine("Bob"), "Delegated to Bob");
    assert.equal(delegationLine("Bob", { effort: "max" }), "Delegated to Bob (max effort)");
    assert.equal(delegationLine("Bob", { fresh: true, effort: "low", note: "start with the API" }), "Delegated to Bob (fresh context, low effort): start with the API");
    assert.equal(delegationLine("Bob", { fresh: true }), "Delegated to Bob (fresh context)");
  });
});

describe("restoreEffortDefault", () => {
  it("puts back the default effort /effort saved over, and keeps the rest of the settings as they are now", () => {
    const before = JSON.stringify({ effortLevel: "xhigh", theme: "dark" });
    const after = JSON.stringify({ effortLevel: "low", theme: "light", env: { A: "1" } });
    assert.deepEqual(JSON.parse(restoreEffortDefault(before, after)!), { effortLevel: "xhigh", theme: "light", env: { A: "1" } });
  });
  it("takes away a default that wasn't there, per model too", () => {
    const after = JSON.stringify({ theme: "dark", effortLevel: "low", modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } });
    assert.deepEqual(JSON.parse(restoreEffortDefault(JSON.stringify({ theme: "dark" }), after)!), { theme: "dark" });
    assert.deepEqual(JSON.parse(restoreEffortDefault(null, JSON.stringify({ effortLevel: "low" }))!), {});
  });
  it("leaves alone what didn't change, and a file it can't read", () => {
    const same = JSON.stringify({ effortLevel: "xhigh" });
    assert.equal(restoreEffortDefault(same, same), null);
    assert.equal(restoreEffortDefault("{ broken", same), null);
    assert.equal(restoreEffortDefault(same, "[]"), null);
  });
});
