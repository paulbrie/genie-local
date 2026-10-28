import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branchSelected, globToRegExp, parsePushLines, pusherSelected, verdictFor, withDefaults } from "./core.mjs";

describe("branchSelected", () => {
  it("matches names and globs, and leaves out !patterns", () => {
    assert.equal(branchSelected("main", ["main", "master"]), true);
    assert.equal(branchSelected("feature/x", ["main"]), false);
    assert.equal(branchSelected("release/1.2", ["release/*"]), true);
    assert.equal(branchSelected("release/1/2", ["release/*"]), false);
    assert.equal(branchSelected("release/1/2", ["release/**"]), true);
    assert.equal(branchSelected("wip/try", ["**", "!wip/*"]), false);
    assert.equal(branchSelected("fix/a", ["**", "!wip/*"]), true);
    assert.equal(branchSelected("main", []), false);
  });
  it("globs: ** also matches no folder", () => {
    assert.equal(globToRegExp("**/package-lock.json").test("package-lock.json"), true);
    assert.equal(globToRegExp("**/package-lock.json").test("a/b/package-lock.json"), true);
    assert.equal(globToRegExp("*.lock").test("a/yarn.lock"), false);
  });
});

describe("pusherSelected", () => {
  it("both, agents only, people only", () => {
    assert.equal(pusherSelected("both", true), true);
    assert.equal(pusherSelected("agents", true), true);
    assert.equal(pusherSelected("agents", false), false);
    assert.equal(pusherSelected("people", true), false);
    assert.equal(pusherSelected("people", false), true);
  });
});

describe("parsePushLines", () => {
  const sha = "a".repeat(40), old = "b".repeat(40), zero = "0".repeat(40);
  it("an update, a new branch, and a deletion (dropped)", () => {
    const lines = parsePushLines(
      [`refs/heads/main ${sha} refs/heads/main ${old}`, `refs/heads/x ${sha} refs/heads/x ${zero}`, `(delete) ${zero} refs/heads/y ${old}`, ""].join("\n"),
    );
    assert.deepEqual(
      lines.map((l) => [l.branch, l.remoteSha]),
      [
        ["main", old],
        ["x", null],
      ],
    );
  });
});

describe("verdictFor", () => {
  const f = (severity: "high" | "medium" | "low") => ({ severity, file: "a", title: "t", detail: "d" });
  it("blocks at the setting's severity or worse, else warns; nothing found passes", () => {
    assert.equal(verdictFor([], "high"), "passed");
    assert.equal(verdictFor([f("medium")], "high"), "warned");
    assert.equal(verdictFor([f("high")], "high"), "blocked");
    assert.equal(verdictFor([f("medium")], "medium"), "blocked");
    assert.equal(verdictFor([f("low")], "medium"), "warned");
    assert.equal(verdictFor([f("high")], "never"), "warned");
  });
  it("defaults: main and master, block on high, both", () => {
    const s = withDefaults({ enabled: true });
    assert.deepEqual([s.branches, s.blockAt, s.who], [["main", "master"], "high", "both"]);
  });
});
