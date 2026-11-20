// The review hook (scripts/review-hook.mjs) end to end, with a stand-in for Claude that streams its steps slowly: its
// progress is in REVIEW_DIR/live while it reviews (where it's at, the commits and the diff, what Claude has read), and
// gone once the result is written; findings at the settings' severity stop the push.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOOK = path.join(process.cwd(), "scripts", "review-hook.mjs");

let base: string, repo: string, reviewDir: string, fakeClaude: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-hook-test-")));
  repo = path.join(base, "repo");
  reviewDir = path.join(base, "review");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "first");
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  git("commit", "-qam", "change a");
  await fs.mkdir(reviewDir, { recursive: true });
  const settings = { enabled: true, branches: ["main"], blockAt: "high", who: "both", effort: "low", skip: [], timeoutSec: 60 };
  await fs.writeFile(path.join(reviewDir, "config.json"), JSON.stringify({ repos: { [repo]: { project: "demo", settings } } }));
  // Claude, as far as the hook can tell: a file read, an aside, the findings, a pause before each
  fakeClaude = path.join(base, "fake-claude.mjs");
  await fs.writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (block) => out({ type: "assistant", message: { content: [block] } });
for await (const _ of process.stdin);
out({ type: "system", subtype: "init" });
await wait(300);
say({ type: "tool_use", name: "Read", input: { file_path: process.cwd() + "/src/a.ts" } });
await wait(300);
say({ type: "text", text: "b is new and unused." });
await wait(1200);
const findings = [{ severity: "high", file: "src/a.ts", line: 2, title: "b is unused", detail: "nothing reads it" }];
say({ type: "tool_use", name: "StructuredOutput", input: { summary: "one problem", findings } });
out({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.01, structured_output: { summary: "one problem", findings } });
`,
    { mode: 0o755 },
  );
});
after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const liveFiles = async () => (await fs.readdir(path.join(reviewDir, "live")).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));

describe("review-hook.mjs", () => {
  it("shows its progress while it reviews, then writes the result, clears it, and stops the push", async () => {
    const head = git("rev-parse", "HEAD");
    // (as git would run it: not inside a Claude session, whose variables mark an agent's push)
    const env: NodeJS.ProcessEnv = { ...process.env, REVIEW_DIR: reviewDir, REVIEW_CLAUDE: fakeClaude };
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDE")) delete env[k];
    const child = spawn(process.execPath, [HOOK, repo, "origin", "file:///nowhere"], {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    // a new branch on the remote: the hook reviews the last commit
    child.stdin.end(`refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`);
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

    // its progress, until the aside shows
    let seen: Record<string, unknown> | null = null;
    for (let i = 0; i < 100 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 50));
      for (const n of await liveFiles()) {
        const live = JSON.parse(await fs.readFile(path.join(reviewDir, "live", n), "utf8"));
        if (live.steps.some((s: { text: string }) => s.text === "b is new and unused.")) seen = live;
      }
    }
    assert.ok(seen, "its progress shows while it reviews");
    assert.equal(seen.phase, "reviewing");
    assert.equal(seen.project, "demo");
    assert.equal(seen.repo, repo);
    assert.equal(seen.branch, "main");
    assert.equal(seen.pid, child.pid);
    assert.deepEqual(seen.commits, ["change a"]);
    assert.deepEqual([seen.files, seen.added, seen.removed], [1, 2, 1]);
    assert.deepEqual((seen.steps as { text: string }[]).map((s) => s.text), ["Reading src/a.ts", "b is new and unused."]);

    assert.equal(await exited, 1, "a high finding stops the push");
    assert.match(stderr, /STOPPED/);
    assert.deepEqual(await liveFiles(), [], "its progress is gone once it's done");
    const [name] = await fs.readdir(path.join(reviewDir, "results"));
    const result = JSON.parse(await fs.readFile(path.join(reviewDir, "results", name), "utf8"));
    assert.equal(result.id, seen.id);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.findings[0].title, "b is unused");
    assert.equal(result.costUsd, 0.01);
  });
});
