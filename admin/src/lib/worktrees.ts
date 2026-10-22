import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { listTerminals } from "@/lib/terminals";

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
