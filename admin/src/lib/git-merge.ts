import "server-only";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

/** git's exit code and output, without throwing (merge-tree exits 1 on conflicts). */
async function gitStatus(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    return { code: 0, out: await git(cwd, args), err: "" };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? String(e) };
  }
}

/** The checkout merges land in (the repo's own, first worktree) and its branch. */
async function target(repoDir: string): Promise<{ dir: string; branch: string; head: string }> {
  const porcelain = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const first = porcelain.trim().split(/\n\n+/)[0] ?? "";
  const dir = /^worktree (.+)$/m.exec(first)?.[1];
  const branch = /^branch refs\/heads\/(.+)$/m.exec(first)?.[1];
  const head = /^HEAD ([0-9a-f]+)$/m.exec(first)?.[1];
  if (!dir || !branch || !head) throw new Error("the main checkout isn't on a branch (detached HEAD): nothing to merge into");
  return { dir, branch, head };
}

/** A local branch name that exists (refs/heads), else throws: nothing user-typed reaches git as an option. */
async function checkBranch(repoDir: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith("-") || (await gitStatus(repoDir, ["check-ref-format", "--branch", branch])).code !== 0) {
    throw new Error(`not a branch name: ${branch}`);
  }
  if ((await gitStatus(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code !== 0) {
    throw new Error(`no local branch ${branch}`);
  }
}

export type MergeCandidate = { branch: string; ahead: number; behind: number; lastCommit: string | null };

/** Local branches with commits the main checkout's branch doesn't have. */
export async function mergeCandidates(repoDir: string): Promise<{ target: string; candidates: MergeCandidate[] }> {
  const t = await target(repoDir);
  const refs = (await git(repoDir, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads"]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const out: MergeCandidate[] = [];
  await Promise.all(
    refs
      .filter(([b]) => b !== t.branch)
      .map(async ([branch, date]) => {
        const counts = await gitStatus(repoDir, ["rev-list", "--left-right", "--count", `${t.branch}...refs/heads/${branch}`]);
        const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
        if (ahead > 0) out.push({ branch, ahead, behind: behind ?? 0, lastCommit: date ?? null });
      }),
  );
  return { target: t.branch, candidates: out.sort((a, b) => (b.lastCommit ?? "").localeCompare(a.lastCommit ?? "")) };
}

export type MergePreview = {
  target: string;
  targetHead: string;
  branch: string;
  commits: { sha: string; subject: string; author: string; at: string }[];
  files: { status: string; path: string }[];
  /** the target is an ancestor of the branch: a fast-forward, no merge commit */
  fastForward: boolean;
  /** files that conflict (git merge-tree, nothing touched); empty = merges cleanly */
  conflicts: string[];
  /** uncommitted files in the main checkout that the merge changes: git would refuse */
  blockedBy: string[];
};

const COMMITS_SHOWN = 50, FILES_SHOWN = 300;

/** What merging `branch` into the main checkout's branch would do; changes nothing. */
export async function previewMerge(repoDir: string, branch: string): Promise<MergePreview> {
  await checkBranch(repoDir, branch);
  const t = await target(repoDir);
  const ref = `refs/heads/${branch}`;
  const [log, diff, ff, tree, dirty] = await Promise.all([
    git(repoDir, ["log", `--max-count=${COMMITS_SHOWN}`, "--format=%h%x09%s%x09%an%x09%cI", `${t.head}..${ref}`]),
    git(repoDir, ["diff", "--name-status", `${t.head}...${ref}`]),
    gitStatus(repoDir, ["merge-base", "--is-ancestor", t.head, ref]),
    gitStatus(repoDir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", t.head, ref]),
    git(t.dir, ["status", "--porcelain"]),
  ]);
  const files = diff
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, FILES_SHOWN)
    .map((l) => {
      const [status, ...p] = l.split("\t");
      return { status, path: p.at(-1) ?? "" };
    });
  // merge-tree: exit 1 = conflicts; the lines after the tree id are the conflicted files
  const conflicts = tree.code === 1 ? tree.out.trim().split("\n").slice(1).filter(Boolean) : [];
  if (tree.code > 1) throw new Error(`git merge-tree failed: ${tree.err.trim()}`);
  const changed = new Set(files.map((f) => f.path));
  const blockedBy = dirty
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").at(-1) ?? "")
    .filter((p) => changed.has(p));
  return {
    target: t.branch,
    targetHead: t.head,
    branch,
    commits: log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author, at] = l.split("\t");
        return { sha, subject, author, at };
      }),
    files,
    fastForward: ff.code === 0,
    conflicts,
    blockedBy,
  };
}

// one merge, checkout, commit or push at a time, from the admin
let busy: string | null = null;

/** Run `fn` unless another git write from the admin is under way (then refuse). */
export async function withRepoLock<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error(`another ${busy} is running`);
  busy = what;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

/**
 * Merge `branch` into the main checkout's branch, in that checkout: a
 * fast-forward when possible, else a merge commit. Refuses if the target moved
 * since the preview (`expectHead`), if it would conflict, or (git itself) if it
 * would overwrite uncommitted work there; a failed merge is aborted.
 */
export async function mergeBranch(repoDir: string, branch: string, expectHead: string): Promise<{ head: string; fastForward: boolean }> {
  return withRepoLock("merge", async () => {
    const p = await previewMerge(repoDir, branch);
    if (p.targetHead !== expectHead) throw new Error(`${p.target} moved since the preview: look again`);
    if (p.conflicts.length) throw new Error(`it would conflict in ${p.conflicts.length} file(s): merge it by hand`);
    if (p.blockedBy.length) throw new Error(`uncommitted changes in the main checkout would be overwritten: ${p.blockedBy.join(", ")}`);
    const t = await target(repoDir);
    const ref = `refs/heads/${branch}`;
    const res = p.fastForward
      ? await gitStatus(t.dir, ["merge", "--ff-only", ref])
      : await gitStatus(t.dir, ["merge", "--no-ff", "--no-edit", "-m", `Merge branch '${branch}' into ${t.branch} (from the admin)`, ref]);
    if (res.code !== 0) {
      // never leave the checkout mid-merge
      await gitStatus(t.dir, ["merge", "--abort"]);
      throw new Error((res.err || res.out).trim().split("\n").slice(0, 6).join(" ") || "git merge failed");
    }
    const head = (await git(t.dir, ["rev-parse", "HEAD"])).trim();
    console.log(`[git-merge] ${branch} → ${t.branch} in ${t.dir}: ${p.fastForward ? "fast-forward" : "merge commit"} ${head}`);
    return { head, fastForward: p.fastForward };
  });
}

const IN_PROGRESS: [string, string][] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/**
 * Switch the repo's main checkout to another local branch (`git switch`), so
 * what runs from it (the dev server) follows. Strict: refuses with uncommitted
 * changes to tracked files, while a merge / rebase / cherry-pick is under way,
 * or when the branch is checked out in a worktree (git allows a branch in one
 * place only). Untracked files stay; git itself refuses if the switch would
 * overwrite one.
 */
export async function switchBranch(
  repoDir: string,
  branch: string,
): Promise<{ dir: string; from: string | null; to: string; head: string }> {
  return withRepoLock("checkout", async () => {
    await checkBranch(repoDir, branch);
    const blocks = (await git(repoDir, ["worktree", "list", "--porcelain"])).trim().split(/\n\n+/);
    const dir = /^worktree (.+)$/m.exec(blocks[0] ?? "")?.[1];
    if (!dir) throw new Error("no main checkout");
    const from = /^branch refs\/heads\/(.+)$/m.exec(blocks[0])?.[1] ?? null;
    if (from === branch) throw new Error(`the checkout is already on ${branch}`);
    const elsewhere = blocks.slice(1).find((b) => /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] === branch);
    if (elsewhere) {
      throw new Error(
        `${branch} is checked out in the worktree ${/^worktree (.+)$/m.exec(elsewhere)?.[1]}: git allows a branch in one place only`,
      );
    }
    const gitDir = (await git(dir, ["rev-parse", "--absolute-git-dir"])).trim();
    const op = IN_PROGRESS.find(([f]) => existsSync(path.join(gitDir, f)))?.[1];
    if (op) throw new Error(`a ${op} is under way in the checkout: finish or abort it first`);
    const dirty = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean);
    if (dirty.length) {
      const some = dirty.slice(0, 5).map((l) => l.slice(3)).join(", ");
      throw new Error(
        `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} in the checkout (${some}${dirty.length > 5 ? ", …" : ""}): commit or stash them first`,
      );
    }
    const res = await gitStatus(dir, ["switch", "--no-guess", branch]);
    if (res.code !== 0) throw new Error((res.err || res.out).trim().split("\n").slice(0, 6).join(" ") || "git switch failed");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    console.log(`[git-checkout] ${dir}: ${from ?? "(detached)"} → ${branch} ${head}`);
    return { dir, from, to: branch, head };
  });
}
