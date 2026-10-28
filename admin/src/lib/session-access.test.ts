import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACCESS_TTL_MS, clearUserAccess, subjectAllowed } from "./session-access.mjs";

describe("subjectAllowed", () => {
  it("the shared admin session always may, without a lookup", async () => {
    let asked = 0;
    const lookup = async () => (asked++, false);
    assert.equal(await subjectAllowed("admin", { lookup }), true);
    assert.equal(await subjectAllowed(undefined, { lookup }), true);
    assert.equal(asked, 0);
  });

  it("a Genie session only while its email is enabled, cached for a few seconds", async () => {
    clearUserAccess();
    let enabled = true, asked = 0;
    const lookup = async () => (asked++, enabled);
    assert.equal(await subjectAllowed("user:a@x.test", { lookup, now: 0 }), true);
    enabled = false;
    assert.equal(await subjectAllowed("user:a@x.test", { lookup, now: 1000 }), true); // cached
    assert.equal(await subjectAllowed("user:a@x.test", { lookup, now: ACCESS_TTL_MS + 1 }), false);
    assert.equal(asked, 2);
  });

  it("clearUserAccess applies a change at once", async () => {
    clearUserAccess();
    let enabled = true;
    const lookup = async () => enabled;
    assert.equal(await subjectAllowed("user:b@x.test", { lookup, now: 0 }), true);
    enabled = false;
    clearUserAccess("B@x.test");
    assert.equal(await subjectAllowed("user:b@x.test", { lookup, now: 1 }), false);
  });

  it("a database error denies and isn't cached; an empty email denies", async () => {
    clearUserAccess();
    let fail = true;
    const lookup = async () => {
      if (fail) throw new Error("db down");
      return true;
    };
    assert.equal(await subjectAllowed("user:c@x.test", { lookup, now: 0 }), false);
    fail = false;
    assert.equal(await subjectAllowed("user:c@x.test", { lookup, now: 1 }), true);
    assert.equal(await subjectAllowed("user:", { lookup }), false);
  });
});
