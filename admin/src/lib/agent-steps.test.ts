import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanLine, firstLine, STEP_MAX, toolStep } from "./agent-steps";

describe("agent steps (T205)", () => {
  it("words tool calls plainly, with only a file's name", () => {
    assert.equal(toolStep("Read", { file_path: "/opt/project/src/lib/lane-sketch-sim.ts" }), "reading lane-sketch-sim.ts");
    assert.equal(toolStep("Edit", { file_path: "/x/ops-view.tsx" }), "editing ops-view.tsx");
    assert.equal(toolStep("Bash", { command: "npm run -s ring:check && tail -3", description: "Run the ring check" }), "running: run the ring check");
    assert.equal(toolStep("Bash", { command: "npm run -s ring:check 2>&1 | tail" }), "running npm run -s");
    assert.equal(toolStep("SendMessage", { to: "Alice", message: "a long body that never shows" }), "messaging Alice");
    assert.equal(toolStep("SendMessage", { to: "uds:/tmp/cc-socks/1.sock" }), "messaging a peer");
    assert.equal(toolStep("WebFetch", { url: "https://sumo.dlr.de/docs/x.html?token=abc" }), "fetching sumo.dlr.de");
    assert.equal(toolStep("Mystery", {}), "using Mystery");
  });
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
    assert.ok(!/hunter22/.test(toolStep("Bash", { command: "psql postgres://app:hunter22@db/x -c 'select 1'" })));
  });
});
