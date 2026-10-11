import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanLine, firstLine, STEP_MAX } from "./agent-steps";

describe("agent steps (T205)", () => {
  it("keeps the first line only, short", () => {
    assert.equal(firstLine("\n\n## Done: the ring works\nmore text"), "Done: the ring works");
    assert.equal(firstLine("   \n"), null);
    assert.equal(firstLine("I've changed **each** project's `belt.ts`"), "I've changed each project's belt.ts");
    assert.ok(cleanLine("x".repeat(200)).length <= STEP_MAX);
  });
  it("never shows a secret: tokens, DB URLs with passwords, KEY=value, private keys", () => {
    for (const bad of [
      "running psql postgres://app:hunter22@db:5432/x",
      "export DATABASE_URL=postgres://u:p@h/d",
      "API_KEY = abcdef123456",
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ]) {
      const out = cleanLine(bad);
      assert.ok(!/hunter22|abcdef123456|AAAAAAAAAAAAAAAAAAAA|ABCDEFGHIJKLMNOPQRST|BEGIN OPENSSH PRIVATE KEY|:p@/.test(out), `${bad} → ${out}`);
    }
    assert.ok(!/hunter22/.test(firstLine("Let me try psql postgres://app:hunter22@db/x -c 'select 1'\nthen…")!));
  });
});
