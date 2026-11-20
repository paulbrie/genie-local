import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branchSelected, describeReviewStep, diffStats, globToRegExp, parsePushLines, pushBudgetMs, pusherSelected, verdictFor, withDefaults } from "./core.mjs";

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

describe("diffStats", () => {
  it("counts the files and the lines added and removed in the hunks, not the headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "++ a line that starts with a plus",
      " same",
      "diff --git a/b.ts b/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+fresh",
    ].join("\n");
    assert.deepEqual(diffStats(diff), { files: 2, added: 3, removed: 1 });
    assert.deepEqual(diffStats(""), { files: 0, added: 0, removed: 0 });
  });
});

describe("describeReviewStep", () => {
  const tool = (name: string, input: object) => ({ type: "tool_use", name, input });
  it("says what Claude reads and looks for, paths from the repo", () => {
    assert.equal(describeReviewStep(tool("Read", { file_path: "/r/src/a.ts" }), "/r"), "Reading src/a.ts");
    assert.equal(describeReviewStep(tool("Grep", { pattern: "withRepoLock", path: "/r/src" }), "/r"), 'Searching for "withRepoLock" in src');
    assert.equal(describeReviewStep(tool("Grep", { pattern: "x" }), "/r"), 'Searching for "x"');
    assert.equal(describeReviewStep(tool("Glob", { pattern: "**/*.test.ts" }), "/r"), "Looking for **/*.test.ts");
  });
  it("counts the findings it writes up, keeps its asides, and leaves out the rest", () => {
    assert.equal(describeReviewStep(tool("StructuredOutput", { summary: "", findings: [{}, {}] })), "Writing up 2 findings");
    assert.equal(describeReviewStep(tool("StructuredOutput", { summary: "", findings: [] })), "Writing up: nothing found");
    assert.equal(describeReviewStep({ type: "text", text: "Let me check  the caller.\n" }), "Let me check the caller.");
    assert.equal(describeReviewStep({ type: "text", text: '{"summary": ""}' }), null);
    assert.equal(describeReviewStep({ type: "thinking", thinking: "…" }), null);
    assert.equal(describeReviewStep(tool("ToolSearch", {})), null);
  });
});

describe("pushBudgetMs", () => {
  it("covers a slot's wait and the review when review is on, two minutes when it's off", () => {
    assert.equal(pushBudgetMs({ ...withDefaults({}), enabled: true, timeoutSec: 240 }), 540_000);
    assert.equal(pushBudgetMs(withDefaults({})), 120_000);
    assert.equal(pushBudgetMs(null), 120_000);
  });
});
