import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { checkoutDir, readStatus, readSync, type GraphView } from "@/lib/git-graph";
import { withRepoLock } from "@/lib/git-merge";

const run = promisify(execFile);

// No prompts: a push that needs credentials fails instead of hanging.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

/** git with pathspecs taken literally (a file named ":(glob)*" is just that file). */
async function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  try {
    return (await run("git", ["--literal-pathspecs", ...args], { cwd, timeout, env: ENV, maxBuffer: 8 * 1024 * 1024 }))
      .stdout;
  } catch (e) {
    const x = e as { stderr?: string; stdout?: string; killed?: boolean };
    if (x.killed) throw new Error(`git ${args[0]} timed out`);
    const msg = `${x.stderr ?? ""}\n${x.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(0, 8).join("\n");
    throw new Error(msg || `git ${args[0]} failed`);
  }
}

async function dirOf(repoDir: string, view: GraphView): Promise<string> {
  const dir = await checkoutDir(repoDir, view);
  if (!dir) throw new Error("this branch isn't checked out anywhere: pick its worktree, or check it out");
  return dir;
}

/**
 * Commit the picked changed files of the view's checkout, as the repo's git
 * identity (its hooks run). Only those files are committed (`commit --only`):
 * anything else staged stays staged. Paths must be ones `git status` lists now.
 */
export async function commitChanges(
  repoDir: string,
  view: GraphView,
  message: string,
  paths: string[],
): Promise<{ dir: string; branch: string | null; sha: string; files: number }> {
  return withRepoLock("commit", async () => {
    const dir = await dirOf(repoDir, view);
    if (!message.trim()) throw new Error("a commit message is needed");
    const status = await readStatus(dir);
    const byPath = new Map(status.map((f) => [f.path, f]));
    const picked = [...new Set(paths)];
    if (!picked.length) throw new Error("no files picked");
    const gone = picked.filter((p) => !byPath.has(p));
    if (gone.length) throw new Error(`no longer changed: ${gone.slice(0, 5).join(", ")}: refresh and pick again`);
    // a (staged) rename commits whole: its old path, already gone from the index, goes with it
    const from = picked.map((p) => byPath.get(p)?.from).filter((x): x is string => !!x);
    await git(dir, ["add", "--all", "--", ...picked]);
    await git(dir, ["commit", "--only", "--cleanup=strip", "-m", message.trim(), "--", ...new Set([...picked, ...from])], 120_000);
    const [sha, branch] = await Promise.all([
      git(dir, ["rev-parse", "HEAD"]),
      git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
    ]);
    console.log(`[git-commit] ${dir}: ${sha.trim().slice(0, 7)} (${picked.length} file(s))`);
    return { dir, branch: branch.trim() || null, sha: sha.trim(), files: picked.length };
  });
}

/**
 * Push the view's checkout's branch to origin, to the branch of the same name
 * (as git's push.default=simple: never into another branch, whatever the
 * upstream is), setting it as upstream when there's none. Never forced: when
 * origin has moved on, git refuses and says so.
 */
export async function pushBranch(
  repoDir: string,
  view: GraphView,
): Promise<{ dir: string; branch: string; pushed: number; created: boolean }> {
  return withRepoLock("push", async () => {
    const dir = await dirOf(repoDir, view);
    const sync = await readSync(dir);
    if (!sync) throw new Error("the checkout is on a detached HEAD: no branch to push");
    if (!sync.origin) throw new Error("this repo has no origin remote");
    const hasUpstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
      () => true,
      () => false,
    );
    const ref = `refs/heads/${sync.branch}`;
    try {
      await git(dir, ["push", "--porcelain", ...(hasUpstream ? [] : ["--set-upstream"]), "origin", `${ref}:${ref}`], 120_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\[rejected\]|non-fast-forward|fetch first/.test(msg)) {
        throw new Error(`origin/${sync.branch} has commits this branch lacks: pull them first (git refuses to overwrite them)`);
      }
      throw e;
    }
    console.log(`[git-push] ${dir}: ${sync.branch} → origin/${sync.branch} (${sync.ahead} commit(s))`);
    return { dir, branch: sync.branch, pushed: sync.ahead, created: !sync.onOrigin };
  });
}
