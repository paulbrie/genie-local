#!/usr/bin/env node
// Review before push: run by the pre-push hook the admin installs in a project's repo (src/lib/code-review), as
//   node review-hook.mjs <repo dir> <remote name> <remote url>   with git's pre-push lines on stdin.
// For each pushed branch the repo's settings select, it has Claude (`claude -p`, read-only tools, structured output)
// review what the push adds, prints the findings, writes the result for the admin to show, and stops the push when a
// finding is at or above the settings' `blockAt` (exit 1). Anything going wrong on its side (no settings, Claude
// missing, a timeout) lets the push through with a note: a review must never be the reason work can't leave.
//
// Plain Node ESM, built-ins only: it runs from git, without the admin's TS runtime. Overrides: REVIEW=skip (logged).

import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { branchSelected, FINDINGS_SCHEMA, parsePushLines, pusherSelected, reviewPrompt, verdictFor, withDefaults } from "../src/lib/code-review/core.mjs";

const DIR = process.env.REVIEW_DIR ?? "/opt/project/.review";
const CONFIG = path.join(DIR, "config.json");
const RESULTS = path.join(DIR, "results");
const CACHE = path.join(DIR, "cache");
const SLOTS = path.join(DIR, "slots");
/** Reviews at once on this box: each is a Claude process, and memory is shared with everything else. */
const MAX_SLOTS = 2;
const MAX_DIFF = 300 * 1024;
const KEEP_RESULTS = 500;

const say = (s = "") => process.stderr.write(`${s}\n`);
const git = (repo, args) =>
  new Promise((resolve, reject) =>
    execFile("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
const gitOk = (repo, args) => git(repo, args).then((o) => o.trim(), () => null);

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

/** Where the review starts: the remote's tip, or for a new branch where it left the remote's main line. */
async function baseFor(repo, remote, push) {
  if (push.remoteSha && (await gitOk(repo, ["cat-file", "-e", `${push.remoteSha}^{commit}`])) !== null) return push.remoteSha;
  for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
    const mb = await gitOk(repo, ["merge-base", push.localSha, ref]);
    if (mb && mb !== push.localSha) return mb;
  }
  // (nothing to compare with: the last commit alone)
  return gitOk(repo, ["rev-parse", "--verify", "--quiet", `${push.localSha}^`]);
}

/** One of MAX_SLOTS review slots (a lock directory holding its owner's pid), waiting up to `ms`. */
async function takeSlot(ms) {
  await fs.mkdir(SLOTS, { recursive: true });
  const until = Date.now() + ms;
  for (;;) {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const slot = path.join(SLOTS, `slot-${i}`);
      try {
        await fs.mkdir(slot);
        await fs.writeFile(path.join(slot, "pid"), String(process.pid));
        return slot;
      } catch {
        // taken: free it if its owner is gone
        const pid = Number(await fs.readFile(path.join(slot, "pid"), "utf8").catch(() => "0"));
        let alive = false;
        try {
          if (pid) {
            process.kill(pid, 0);
            alive = true;
          }
        } catch {
          /* gone */
        }
        if (!alive) await fs.rm(slot, { recursive: true, force: true });
      }
    }
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Claude's review of `diff`, or { error }. Its own env, cleared of the calling session's (an agent's push). */
function claudeReview({ repo, prompt, diff, effort, timeoutMs }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(FINDINGS_SCHEMA), "--effort", effort, "--no-session-persistence",
    "--allowedTools", "Read", "Grep", "Glob", "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "--", prompt];
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const child = spawn(process.env.REVIEW_CLAUDE ?? "claude", args, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve({ error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ error: e.code === "ENOENT" ? "claude isn't installed here" : e.message });
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const o = JSON.parse(out);
        const s = o.structured_output;
        if (o.is_error || !s || !Array.isArray(s.findings)) return resolve({ error: (o.result || err || "no answer").toString().slice(0, 300) });
        resolve({ summary: s.summary ?? "", findings: s.findings, costUsd: o.total_cost_usd ?? null });
      } catch {
        resolve({ error: (err || out || "no answer").slice(0, 300) });
      }
    });
    child.stdin.end(diff);
  });
}

async function saveResult(r) {
  await fs.mkdir(RESULTS, { recursive: true });
  await fs.writeFile(path.join(RESULTS, `${r.at}-${r.id}.json`), JSON.stringify(r, null, 1));
  // (the newest KEEP_RESULTS stay)
  const names = (await fs.readdir(RESULTS)).filter((n) => n.endsWith(".json")).sort();
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_RESULTS))) await fs.rm(path.join(RESULTS, n), { force: true });
}

function printFindings(findings) {
  for (const f of findings) {
    say(`  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.title}`);
    for (const l of String(f.detail).split("\n")) say(`      ${l}`);
  }
}

async function main() {
  const [repoArg, remote = "origin"] = process.argv.slice(2);
  const repo = (await gitOk(repoArg ?? ".", ["rev-parse", "--show-toplevel"])) ?? path.resolve(repoArg ?? ".");
  const stdin = await readStdin();
  const config = JSON.parse(await fs.readFile(CONFIG, "utf8").catch(() => "{}"));
  // (settings are per repo; a linked worktree shares its main repo's)
  const common = await gitOk(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mainRepo = common ? path.dirname(common) : repo;
  const entry = config.repos?.[repo] ?? config.repos?.[mainRepo];
  if (!entry) return 0;
  const settings = withDefaults(entry.settings);
  if (!settings.enabled) return 0;
  const isAgent = !!process.env.CLAUDECODE;
  if (!pusherSelected(settings.who, isAgent)) return 0;

  let blocked = false;
  for (const push of parsePushLines(stdin)) {
    if (!branchSelected(push.branch, settings.branches)) continue;
    const started = Date.now();
    const result = {
      id: randomUUID().slice(0, 8),
      at: new Date(started).toISOString(),
      project: entry.project,
      repo,
      branch: push.branch,
      remote,
      head: push.localSha,
      base: null,
      commits: [],
      pusher: isAgent ? "agent" : "person",
      verdict: "error",
      summary: "",
      findings: [],
      note: null,
      cached: false,
      durationMs: 0,
      costUsd: null,
    };
    try {
      if (process.env.REVIEW === "skip") {
        Object.assign(result, { verdict: "overridden", note: "REVIEW=skip" });
        say(`review: skipped for ${push.branch} (REVIEW=skip), and noted.`);
        continue;
      }
      const base = await baseFor(repo, remote, push);
      result.base = base;
      const range = base ? `${base}..${push.localSha}` : push.localSha;
      result.commits = ((await gitOk(repo, ["log", "--format=%s", "-50", range])) ?? "").split("\n").filter(Boolean);
      const excludes = settings.skip.map((g) => `:(exclude,glob)${g}`);
      let diff = base ? await git(repo, ["diff", "--no-color", "-M", base, push.localSha, "--", ".", ...excludes]) : await git(repo, ["show", "--no-color", "--format=", push.localSha, "--", ".", ...excludes]);
      if (!diff.trim()) {
        Object.assign(result, { verdict: "passed", summary: "Nothing to review (only skipped files changed)." });
        continue;
      }
      const truncated = diff.length > MAX_DIFF;
      if (truncated) diff = diff.slice(0, MAX_DIFF);

      // the same changes under the same settings: the same answer
      const key = createHash("sha256").update([base, push.localSha, settings.effort, settings.skip.join(",")].join("\n")).digest("hex").slice(0, 32);
      const cacheFile = path.join(CACHE, `${key}.json`);
      let review = JSON.parse(await fs.readFile(cacheFile, "utf8").catch(() => "null"));
      if (review) result.cached = true;
      else {
        say(`review: Claude is reviewing ${result.commits.length} commit(s) on ${push.branch}${truncated ? " (diff cut short for size)" : ""}…`);
        const slot = await takeSlot(settings.timeoutSec * 1000);
        if (!slot) {
          Object.assign(result, { verdict: "error", note: "two other reviews were still running: let through unreviewed" });
          say("review: busy (two reviews already running): let through unreviewed.");
          continue;
        }
        try {
          review = await claudeReview({
            repo,
            prompt: reviewPrompt({ project: entry.project, branch: push.branch, commits: result.commits, truncated }),
            diff,
            effort: settings.effort,
            timeoutMs: settings.timeoutSec * 1000,
          });
        } finally {
          await fs.rm(slot, { recursive: true, force: true });
        }
        if (!review.error) {
          await fs.mkdir(CACHE, { recursive: true });
          await fs.writeFile(cacheFile, JSON.stringify(review));
        }
      }
      if (review.error) {
        Object.assign(result, { verdict: review.error === "timeout" ? "timeout" : "error", note: review.error });
        say(`review: couldn't review (${review.error}): let through.`);
        continue;
      }
      Object.assign(result, { summary: review.summary, findings: review.findings, costUsd: result.cached ? null : review.costUsd });
      result.verdict = verdictFor(review.findings, settings.blockAt);
      if (result.verdict === "passed") say(`review: ${push.branch}: nothing found.${result.cached ? " (as reviewed before)" : ""}`);
      else {
        say(`review: ${push.branch}: ${review.findings.length} finding(s)${result.cached ? " (as reviewed before)" : ""}. ${review.summary}`);
        printFindings(review.findings);
      }
      if (result.verdict === "blocked") {
        blocked = true;
        say("");
        say(`review: push to ${push.branch} STOPPED: findings at "${settings.blockAt}" or worse.`);
        say("        Fix them and push again, or, if they're wrong, push with REVIEW=skip (it is noted).");
        if (isAgent) say("        Agents: don't use --no-verify to get round this; fix the findings or ask the user.");
      }
    } catch (e) {
      Object.assign(result, { verdict: "error", note: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
      say(`review: couldn't review (${result.note}): let through.`);
    } finally {
      result.durationMs = Date.now() - started;
      await saveResult(result).catch(() => {});
    }
  }
  return blocked ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    say(`review: ${e?.message ?? e}: let through.`);
    process.exit(0);
  },
);
