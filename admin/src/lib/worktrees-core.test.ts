import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ownSizes, parseDuTotal } from "./worktrees-core";

describe("ownSizes", () => {
  it("takes the worktrees inside one out of its figure, once, from the nearest around them", () => {
    const sizes = ownSizes({
      "/r": 1000,
      "/r/.claude/worktrees/a": 300,
      "/r/.claude/worktrees/a/nested": 50,
      "/r/.claude/worktrees/b": 100,
      "/home/x/scratch/r-wt": 400,
      "/rx": 70,
    });
    assert.deepEqual(sizes, {
      "/r": 600,
      "/r/.claude/worktrees/a": 250,
      "/r/.claude/worktrees/a/nested": 50,
      "/r/.claude/worktrees/b": 100,
      "/home/x/scratch/r-wt": 400,
      "/rx": 70,
    });
  });

  it("leaves a figure it doesn't know as it is, and takes nothing for one inside that wasn't measured", () => {
    assert.deepEqual(ownSizes({ "/r": null, "/r/w": 10 }), { "/r": null, "/r/w": 10 });
    assert.deepEqual(ownSizes({ "/r": 100, "/r/w": null }), { "/r": 100, "/r/w": null });
  });
});

describe("parseDuTotal", () => {
  it("reads du's total, even after its complaints", () => {
    assert.equal(parseDuTotal("12884901888\t/opt/project/projects/acccess\n"), 12884901888);
    assert.equal(parseDuTotal(""), null);
    assert.equal(parseDuTotal("du: cannot access 'x': No such file or directory\n"), null);
  });
});
