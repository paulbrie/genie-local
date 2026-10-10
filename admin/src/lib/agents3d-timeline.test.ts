import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoOfCommit } from "./agents3d-timeline";

// T133's case: two repos with no admin project (the admin's own, a worktree in /tmp) and two that have one.
const repos = [
  { id: "/opt/project", project: null, app: null },
  { id: "/tmp/ramona/t68-wt", project: null, app: null },
  { id: "/opt/project/projects/trafficsim", project: "trafficsim", app: null },
  { id: "/opt/project/projects/roa/server-app", project: "roa", app: "server-app" },
];

describe("repoOfCommit (T136)", () => {
  it("a commit goes to the repo it was found in, by its directory", () => {
    assert.equal(repoOfCommit({ repo: "/opt/project", project: null, app: null }, repos), "/opt/project");
    assert.equal(repoOfCommit({ repo: "/tmp/ramona/t68-wt", project: null, app: null }, repos), "/tmp/ramona/t68-wt");
    assert.equal(repoOfCommit({ repo: "/opt/project/projects/trafficsim", project: "trafficsim", app: null }, repos), "/opt/project/projects/trafficsim");
  });
  it("two repos without a project don't share one key: the admin's commits stay the admin's", () => {
    const admin = [1, 2, 3, 4, 5, 6, 7].map(() => repoOfCommit({ repo: "/opt/project", project: null, app: null }, repos));
    assert.ok(admin.every((r) => r === "/opt/project"));
  });
  it("its repo not laid out: none (not another one's)", () => {
    assert.equal(repoOfCommit({ repo: "/somewhere/else", project: null, app: null }, repos), null);
  });
  it("without a directory (an older cached commit): by project and app; never for no project", () => {
    assert.equal(repoOfCommit({ repo: null, project: "roa", app: "server-app" }, repos), "/opt/project/projects/roa/server-app");
    assert.equal(repoOfCommit({ repo: null, project: "trafficsim", app: null }, repos), "/opt/project/projects/trafficsim");
    assert.equal(repoOfCommit({ repo: null, project: null, app: null }, repos), null);
  });
});
