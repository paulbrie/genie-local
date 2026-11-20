import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ensureClaudeMemory } from "./claude-memory";
import { MEMORY_ENV, withMemoryEnv } from "./claude-memory-core";

describe("withMemoryEnv", () => {
  it("adds the memory base to the settings, keeping what's there", () => {
    const r = withMemoryEnv(JSON.stringify({ model: "opus", env: { FOO: "1" } }), "/h/claude-memory");
    assert.ok(!("error" in r));
    assert.equal(r.changed, true);
    assert.deepEqual(JSON.parse(r.text), { model: "opus", env: { FOO: "1", [MEMORY_ENV]: "/h/claude-memory" } });
    assert.ok(r.text.endsWith("\n"));
  });
  it("writes settings of their own where there are none", () => {
    for (const none of [null, "", "  \n"]) {
      const r = withMemoryEnv(none, "/b");
      assert.ok(!("error" in r));
      assert.deepEqual(JSON.parse(r.text), { env: { [MEMORY_ENV]: "/b" } });
    }
  });
  it("keeps a base someone set, and says so", () => {
    const text = JSON.stringify({ env: { [MEMORY_ENV]: "/elsewhere" } });
    assert.deepEqual(withMemoryEnv(text, "/b"), { text, changed: false, base: "/elsewhere" });
  });
  it("leaves a file it can't read as settings alone", () => {
    assert.ok("error" in withMemoryEnv("{ not json", "/b"));
    assert.ok("error" in withMemoryEnv("[]", "/b"));
    assert.ok("error" in withMemoryEnv(JSON.stringify({ env: ["x"] }), "/b"));
  });
});

describe("ensureClaudeMemory", () => {
  let home: string;
  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "claude-memory-test-"));
    const mem = (p: string) => path.join(home, ".claude", "projects", p, "memory");
    await fs.mkdir(mem("-opt-project"), { recursive: true });
    await fs.writeFile(path.join(mem("-opt-project"), "MEMORY.md"), "- [a](a.md) — one\n");
    await fs.writeFile(path.join(mem("-opt-project"), "a.md"), "a fact\n");
    await fs.mkdir(mem("-opt-project-projects-shop"), { recursive: true });
    await fs.mkdir(path.join(home, ".claude", "projects", "-tmp"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }, null, 2), { mode: 0o600 });
  });
  after(() => fs.rm(home, { recursive: true, force: true }));

  it("points the sessions at the new base, copies each project's memory over once, and keeps the settings' mode", async () => {
    const base = path.join(home, "claude-memory");
    const r = await ensureClaudeMemory(home, base);
    assert.deepEqual(r, { base, set: true, copied: ["-opt-project"] });
    const settings = path.join(home, ".claude", "settings.json");
    assert.deepEqual(JSON.parse(await fs.readFile(settings, "utf8")), { theme: "dark", env: { [MEMORY_ENV]: base } });
    assert.equal((await fs.stat(settings)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(base)).mode & 0o777, 0o700);
    assert.equal(await fs.readFile(path.join(base, "projects", "-opt-project", "memory", "a.md"), "utf8"), "a fact\n");
    // the old ones stay where they were
    assert.ok(await fs.stat(path.join(home, ".claude", "projects", "-opt-project", "memory", "a.md")));

    // again (the next start): nothing to do, and a memory written in the new place since isn't overwritten
    await fs.writeFile(path.join(base, "projects", "-opt-project", "memory", "a.md"), "newer\n");
    assert.deepEqual(await ensureClaudeMemory(home, base), { base, set: false, copied: [] });
    assert.equal(await fs.readFile(path.join(base, "projects", "-opt-project", "memory", "a.md"), "utf8"), "newer\n");
  });
});
