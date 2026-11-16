import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { withRepoLock } from "@/lib/git-merge";
import { listTerminals } from "@/lib/terminals";
import { ownSizes, parseDuTotal } from "@/lib/worktrees-core";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;

/** One git worktree of a repo, with what an agent is doing in it. */
export type Worktree = {
  path: string;
  /** the repo's own checkout (the first `git worktree list` entry) */
  main: boolean;
  branch: string | null;
  head: string;
  detached: boolean;
  /** "locked claude session <name> (pid …)": Claude Code's own worktrees */
  lockedBy: string | null;
  /** the folder is gone (git calls it prunable) */
  missing: boolean;
  /** files with uncommitted changes (null: couldn't read) */
  changes: number | null;
  /** commits ahead / behind the main checkout's branch (null: same branch, or unknown) */
  ahead: number | null;
  behind: number | null;
  lastCommit: { at: string; subject: string } | null;
  /**
   * The terminals working in it: named for it ("Bob…" ↔ ~/bob-scratch/…, branch
   * wt/bob…), or, for a terminal named for none, the one its folder is in.
   */
  agents: string[];
};

/** `git worktree list --porcelain`, one block per worktree. */
function parsePorcelain(out: string) {
  return out
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const line = (k: string) => block.split("\n").find((l) => l === k || l.startsWith(`${k} `));
      const val = (k: string) => line(k)?.slice(k.length + 1) ?? null;
      const locked = line("locked");
      return {
        path: val("worktree") ?? "",
        head: val("HEAD") ?? "",
        branch: val("branch")?.replace(/^refs\/heads\//, "") ?? null,
        detached: !!line("detached"),
        lockedBy: locked ? locked.slice("locked".length).trim() || "locked" : null,
        missing: !!line("prunable"),
      };
    });
}

/** The repo's worktrees (its own checkout first), each with its state and agents. */
export async function listWorktrees(repoDir: string): Promise<Worktree[]> {
  const [raw, terminals] = await Promise.all([
    git(repoDir, ["worktree", "list", "--porcelain"]),
    listTerminals().catch(() => []),
  ]);
  const trees = parsePorcelain(raw);
  const mainBranch = trees[0]?.branch ?? null;
  // Agents keep their shell in the main checkout and work in their worktree by
  // path, so the folder says little: match the team's convention first, an
  // agent "Bob…" in ~/bob-scratch/… or on a wt/bob… branch.
  const byName = (name: string) => {
    const who = /^[a-z]+/i.exec(name)?.[0]?.toLowerCase();
    if (!who || who.length < 3) return [];
    const scratch = new RegExp(`(^|/)${who}-scratch(/|$)`, "i");
    return trees
      .filter((t) => scratch.test(t.path) || t.branch?.toLowerCase().startsWith(`wt/${who}`))
      .map((t) => t.path);
  };
  // otherwise the deepest worktree containing the terminal's folder
  const byFolder = (cwd: string) =>
    trees
      .filter((t) => cwd === t.path || cwd.startsWith(t.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  const worksIn = new Map(
    terminals.map((x) => {
      const named = byName(x.name);
      return [x.name, named.length ? named : [byFolder(x.cwd)].filter((p): p is string => !!p)];
    }),
  );

  return Promise.all(
    trees.map(async (t, i): Promise<Worktree> => {
      const base = {
        ...t,
        main: i === 0,
        agents: terminals.filter((x) => worksIn.get(x.name)?.includes(t.path)).map((x) => x.name),
      };
      if (t.missing) return { ...base, changes: null, ahead: null, behind: null, lastCommit: null };
      const [status, log, counts] = await Promise.all([
        git(t.path, ["status", "--porcelain"]).catch(() => null),
        git(t.path, ["log", "-1", "--format=%cI%x09%s"]).catch(() => null),
        mainBranch && t.branch && t.branch !== mainBranch
          ? git(repoDir, ["rev-list", "--left-right", "--count", `${mainBranch}...${t.head}`]).catch(() => null)
          : Promise.resolve(null),
      ]);
      const [behind, ahead] = counts ? counts.trim().split(/\s+/).map(Number) : [null, null];
      const [at, ...subject] = log?.trim().split("\t") ?? [];
      return {
        ...base,
        changes: status == null ? null : status.split("\n").filter(Boolean).length,
        ahead: ahead ?? null,
        behind: behind ?? null,
        lastCommit: at ? { at, subject: subject.join("\t") } : null,
      };
    }),
  );
}

// (each worktree's folder as du measured it, by path, kept a little: a big tree takes du a while the first time)
const SIZE_FRESH_MS = 2 * 60_000;
const measured = new Map<string, { at: number; p: Promise<number | null> }>();

/** du of a folder at low priority (it can say something even when it exits non-zero, a folder in it unreadable). */
function du(dir: string): Promise<number | null> {
  const hit = measured.get(dir);
  if (hit && Date.now() - hit.at < SIZE_FRESH_MS) return hit.p;
  const p = run("nice", ["-n", "19", "du", "-sxB1", "--", dir], { timeout: 180_000 }).then(
    (r) => parseDuTotal(r.stdout),
    (e: { stdout?: string }) => parseDuTotal(e.stdout ?? ""),
  );
  measured.set(dir, { at: Date.now(), p });
  if (measured.size > 200) measured.delete(measured.keys().next().value!);
  return p;
}

/**
 * The room each worktree takes on disk, by path: its folder, less the worktrees inside it. The main checkout's
 * counts .git, the history they all share. Null: its folder is gone, or du said nothing.
 */
export async function worktreeSizes(repoDir: string): Promise<Record<string, number | null>> {
  const trees = parsePorcelain(await git(repoDir, ["worktree", "list", "--porcelain"]));
  const sizes = await Promise.all(trees.map((t) => (t.missing ? null : du(t.path))));
  return ownSizes(Object.fromEntries(trees.map((t, i) => [t.path, sizes[i]])));
}

/**
 * Delete worktree `dir` of the repo (`git worktree remove`; a worktree's right-click on the Git tab), never the repo's
 * own checkout; its branch stays. Unforced, nothing changes when there's work in it to lose or a hold on it: `changes`,
 * its uncommitted files (untracked ones too; ignored ones, node_modules and builds, go with it), and `lockedBy` (Claude
 * Code locks its own while a session works in one). The caller asks, then `force` deletes it all the same.
 */
export async function removeWorktree(
  repoDir: string,
  dir: string,
  force: boolean,
): Promise<{ removed: true; branch: string | null } | { removed: false; changes: number; lockedBy: string | null }> {
  return withRepoLock("worktree delete", async () => {
    const trees = parsePorcelain(await git(repoDir, ["worktree", "list", "--porcelain"]));
    const i = trees.findIndex((t) => t.path === dir);
    if (i < 0) throw new Error(`${dir} isn't one of this repo's worktrees`);
    if (i === 0) throw new Error("that's the repo's own checkout: it isn't deleted from here");
    const t = trees[i];
    if (!force) {
      const status = t.missing ? "" : await git(t.path, ["status", "--porcelain"]).catch(() => "");
      const changes = status.split("\n").filter(Boolean).length;
      if (changes || t.lockedBy) return { removed: false, changes, lockedBy: t.lockedBy };
    }
    try {
      // (a big one takes a while to delete; -f -f: uncommitted work and a lock alike)
      await run("git", ["worktree", "remove", ...(force ? ["-f", "-f"] : []), "--", t.path], { cwd: repoDir, timeout: 300_000 });
    } catch (e) {
      const x = e as { stderr?: string; message?: string };
      throw new Error((x.stderr || x.message || "git worktree remove failed").trim().split("\n").slice(0, 4).join(" "));
    }
    measured.delete(t.path);
    console.log(`[git-worktree] removed ${t.path} (${t.branch ?? t.head.slice(0, 7)})${force ? " (forced)" : ""}`);
    return { removed: true, branch: t.branch };
  });
}
