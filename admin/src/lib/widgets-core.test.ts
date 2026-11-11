import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthOf, parseGitStatus } from "./widgets-core";

describe("healthOf", () => {
  const svc = (unit: string, active: string, sub = "running", curated = true) => ({ unit, active, sub, curated });
  const ctr = (name: string, state: string, status: string) => ({ name, state, status });
  it("puts what needs you first, and leaves out the services nobody picked", () => {
    const h = healthOf(
      [svc("nginx.service", "active"), svc("admin-dev.service", "inactive", "dead"), svc("cron.service", "failed", "failed"), svc("apport.service", "active", "exited", false)],
      [ctr("db-1", "running", "Up 8 days (healthy)"), ctr("web", "running", "Up 2 min (unhealthy)"), ctr("old-test", "exited", "Exited (0) 3 days ago")],
    );
    assert.deepEqual(
      h.map((i) => [i.name, i.state]),
      [
        ["cron", "down"],
        ["web", "down"],
        ["db-1", "ok"],
        ["nginx", "ok"],
        ["admin-dev", "off"],
        ["old-test", "off"],
      ],
    );
  });
  it("tells a crash from a clean stop, and a start from a failure", () => {
    const h = healthOf([svc("x.service", "activating", "start")], [ctr("crashed", "exited", "Exited (137) 1 hour ago"), ctr("loop", "restarting", "Restarting (1) 5 seconds ago"), ctr("new", "running", "Up 3 seconds (health: starting)")]);
    const by = Object.fromEntries(h.map((i) => [i.name, i.state]));
    assert.deepEqual(by, { x: "warn", crashed: "down", loop: "down", new: "warn" });
  });
});

describe("parseGitStatus", () => {
  it("reads the branch, how far it is from its upstream, and what changed", () => {
    const out = [
      "# branch.oid 1a2b3c",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 a b src/a.ts",
      "2 R. N... 100644 100644 100644 a b R100 src/c.ts\tsrc/b.ts",
      "u UU N... 100644 100644 100644 100644 a b c src/d.ts",
      "? notes.txt",
      "? tmp/",
    ].join("\n");
    assert.deepEqual(parseGitStatus(out), { branch: "main", upstream: true, ahead: 2, behind: 1, changed: 3, untracked: 2 });
  });
  it("is clean with no upstream, and has no branch when detached", () => {
    assert.deepEqual(parseGitStatus("# branch.oid abc\n# branch.head (detached)\n"), { branch: null, upstream: false, ahead: 0, behind: 0, changed: 0, untracked: 0 });
  });
});
