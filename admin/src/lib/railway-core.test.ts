import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { deploymentMeta, deployRuntimeLine, httpRuntimeLine, lastN, logLine, logWindow, repoKey, stateOf } from "./railway-core";
import { problemOf } from "./vercel-issues-core";

describe("railway-core", () => {
  it("reads a deployment's status as a dot", () => {
    assert.equal(stateOf("SUCCESS"), "ok");
    assert.equal(stateOf("CRASHED"), "failed");
    assert.equal(stateOf("FAILED"), "failed");
    assert.equal(stateOf("BUILDING"), "busy");
    assert.equal(stateOf("REMOVED"), "off");
    assert.equal(stateOf("SLEEPING"), "off");
  });

  it("asks for logs between two times as Railway's CLI does, and keeps the last ones of its answer", () => {
    const w = logWindow(new Date("2026-11-24T10:00:00Z"), new Date("2026-11-24T10:05:00Z"), 200);
    assert.deepEqual(w, {
      beforeDate: "2026-11-24T10:00:00.000Z",
      beforeLimit: 200,
      anchorDate: "2026-11-24T10:05:00.000Z",
      afterDate: "2026-11-24T10:05:00.000Z",
      afterLimit: 0,
    });
    assert.deepEqual(lastN([1, 2, 3, 4], 3), [2, 3, 4]);
    assert.deepEqual(lastN([1], 3), [1]);
  });

  it("reads a log line's level from its attributes, else its severity", () => {
    assert.deepEqual(logLine({ timestamp: "2026-11-24T10:00:00Z", message: "\x1b[31mboom\x1b[0m", attributes: [{ key: "level", value: "error" }] }), {
      at: Date.parse("2026-11-24T10:00:00Z"),
      level: "error",
      text: "boom",
    });
    assert.equal(logLine({ timestamp: "x", message: "hi", severity: "WARN" }).level, "warn");
    assert.equal(logLine({ timestamp: "x", message: "hi" }).level, "info");
    assert.equal(logLine({ timestamp: "x", message: "hi" }).at, null);
  });

  it("reads where a deployment came from", () => {
    assert.deepEqual(deploymentMeta({ branch: "main", commitHash: "8c108ec9f00", commitMessage: "fix: x\n\nmore", repo: "acme/shop" }), {
      branch: "main",
      commit: "8c108ec",
      message: "fix: x",
      repo: "acme/shop",
    });
    assert.deepEqual(deploymentMeta(null), { branch: null, commit: null, message: null, repo: null });
  });

  it("matches a service's repo to the project's origin", () => {
    assert.equal(repoKey("Acme/Shop"), "acme/shop");
    assert.equal(repoKey("git@github.com:acme/shop.git"), "acme/shop");
    assert.equal(repoKey("https://github.com/acme/shop"), "acme/shop");
    assert.equal(repoKey(null), null);
  });

  it("turns error lines and 5xx responses into production problems, and leaves the rest", () => {
    const err = problemOf(deployRuntimeLine({ at: 1, level: "error", text: "TypeError: x is undefined" }));
    assert.equal(err?.level, "error");
    assert.equal(problemOf(deployRuntimeLine({ at: 1, level: "warn", text: "slow query" }))?.level, "warning");
    assert.equal(problemOf(deployRuntimeLine({ at: 1, level: "info", text: "listening" })), null);
    const failed = problemOf(httpRuntimeLine({ timestamp: "2026-11-24T10:00:00Z", method: "GET", path: "/orders/123", httpStatus: 502, upstreamErrors: "[]" }));
    assert.equal(failed?.title, "HTTP 502 on GET /orders/:id");
    assert.equal(problemOf(httpRuntimeLine({ timestamp: "2026-11-24T10:00:00Z", method: "GET", path: "/", httpStatus: 404 })), null);
  });
});
