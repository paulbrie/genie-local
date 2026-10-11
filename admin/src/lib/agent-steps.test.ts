import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actOf, cleanLine, firstLine, STEP_MAX } from "./agent-steps";

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
  it("tool calls as kinds and sizes only, for the monitors (T205c): never their text", () => {
    const at = "2026-10-11T18:00:00Z";
    assert.deepEqual(actOf("Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "abcdef" }, at), { kind: "edit", at, len: 6 });
    assert.deepEqual(actOf("MultiEdit", { edits: [{ new_string: "ab" }, { new_string: "cde" }, null] }, at), { kind: "edit", at, len: 5 });
    assert.deepEqual(actOf("Write", { content: "x".repeat(20000) }, at), { kind: "edit", at, len: 9999 });
    assert.deepEqual(actOf("Bash", { command: "psql postgres://u:secret@h/d" }, at), { kind: "bash", at, len: 28 });
    assert.deepEqual(actOf("Grep", { pattern: "x" }, at), { kind: "read", at, len: 0 });
    assert.deepEqual(actOf("SendMessage", { to: "Alice", message: "hello" }, at), { kind: "other", at, len: 0 });
    assert.equal(Object.keys(actOf("Bash", { command: "a secret" }, at)).sort().join(), "at,kind,len", "no text field at all");
  });
});
