import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normMessage, normPath, problemOf, type RuntimeLine } from "./vercel-issues-core";

const line = (o: Partial<RuntimeLine>): RuntimeLine => ({ at: 1, level: "info", source: "function", text: "", method: "GET", path: "/", status: 200, ...o });

describe("production problems", () => {
  it("keeps errors, warnings and 5xx; drops the rest", () => {
    assert.equal(problemOf(line({ text: "→ /about (public)" })), null);
    assert.equal(problemOf(line({ status: 404 })), null);
    assert.equal(problemOf(line({ level: "error", text: "boom" }))?.level, "error");
    assert.equal(problemOf(line({ level: "warning", text: "careful" }))?.level, "warning");
    const failed = problemOf(line({ status: 502, path: "/api/users/42" }));
    assert.equal(failed?.level, "error");
    assert.equal(failed?.title, "HTTP 502 on GET /api/users/:id");
  });
  it("ignores the marker Vercel ends each 5-minute log stream with", () => {
    const marker = { level: "error", source: "delimiter", text: "Exceeded query duration limit of 5 minutes", method: null, path: null, status: null };
    assert.equal(problemOf(line(marker)), null);
    // the same text printed by the app itself is still a problem
    assert.equal(problemOf(line({ ...marker, source: "lambda" }))?.level, "error");
  });
  it("counts the same problem once, whatever its ids", () => {
    const a = problemOf(line({ level: "error", text: "\x1b[31mUser 123 not found (id 9f8e7d6c5b4a3210)\x1b[0m\n    at x" }));
    const b = problemOf(line({ level: "error", text: "User 456 not found (id 0123456789abcdef)" }));
    assert.equal(a?.fingerprint, b?.fingerprint);
    assert.equal(a?.title, "User 123 not found (id 9f8e7d6c5b4a3210)");
    assert.notEqual(a?.fingerprint, problemOf(line({ level: "error", text: "Database timeout" }))?.fingerprint);
    // (an error and a warning saying the same are two issues)
    assert.notEqual(a?.fingerprint, problemOf(line({ level: "warning", text: "User 1 not found (id 9f8e7d6c5b4a3210)" }))?.fingerprint);
  });
  it("normalizes paths and messages", () => {
    assert.equal(normPath("/u/123/o/9f8e7d6c-1234-4abc-9def-0123456789ab?x=1"), "/u/:id/o/:id");
    assert.equal(normMessage(`Failed "https://a.b/c?d=1" after 300ms`), "failed <str> after #ms");
  });
});
