import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { PROJECTS_ROOT, resolveProjectPath } from "@/lib/signals";

const execFileAsync = promisify(execFile);

/** How many commits (across all branches, date-ordered) the graph loads. */
const LOG_LIMIT = 200;
/** Cap on diff bytes returned for one commit, so a huge commit can't OOM us. */
const DIFF_MAX_BUFFER = 16 * 1024 * 1024;

/** ASCII unit/record separators — safe field delimiters for `git log` output. */
const US = "\x1f";
const RS = "\x1e";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitRef = {
  /** Short ref name, e.g. "main", "origin/main", "v1.2.0". */
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
};

export type Commit = {
  hash: string;
  abbrev: string;
  parents: string[];
  refs: GitRef[];
  authorName: string;
  /** Author date, ISO-8601. */
  authorDate: string;
  subject: string;
};

/** One placed commit row plus the edge segments in the gap ABOVE it. */
export type GraphRow = {
  commit: Commit;
  /** Column (lane index) the commit dot sits in. */
  column: number;
  /** Palette index for the commit's lane. */
  color: number;
  /**
   * Line segments filling the vertical gap between the previous row and this
   * one. Each connects column `top` (previous row's level) to column `bottom`
   * (this row's level). Passthrough lanes have `top === bottom`.
   */
  edgesAbove: { top: number; bottom: number; color: number }[];
};

export type GitStatusFile = {
  /** Two-char porcelain XY code, e.g. " M", "??", "A ". */
  code: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
};

export type GitGraph = {
  branch: string | null;
  /** Column count, for sizing the SVG. */
  columns: number;
  rows: GraphRow[];
  status: GitStatusFile[];
  /** True when the log was truncated at LOG_LIMIT. */
  truncated: boolean;
};

/** A git repo inside a project (an app dir with a .git). */
export type GitRepo = { app: string; path: string };

// ---------------------------------------------------------------------------
// Repo resolution (path-traversal guarded, mirrors signals.ts)
// ---------------------------------------------------------------------------

async function isRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every git repo under a project: the project dir itself if it is one, else its
 * immediate app subdirectories that are repos. Same depth-1 model as
 * discoverApps() in signals.ts, but keyed to git presence.
 */
export async function listRepos(projectSlug: string): Promise<GitRepo[]> {
  const projectDir = resolveProjectPath(projectSlug);
  if (await isRepo(projectDir)) return [{ app: "", path: projectDir }];
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return [];
  }
  const repos: GitRepo[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const child = path.join(projectDir, name);
    try {
      if ((await fs.stat(child)).isDirectory() && (await isRepo(child)))
        repos.push({ app: name, path: child });
    } catch {
      /* unreadable — skip */
    }
  }
  return repos;
}

/**
 * Resolve a repo directory for (project, app), guarding against traversal: the
 * result must be the project dir or a direct child of it, and must be a repo.
 * Returns null if the app slug names no such repo.
 */
export async function resolveRepo(
  projectSlug: string,
  appSlug: string,
): Promise<string | null> {
  const projectDir = resolveProjectPath(projectSlug);
  if (!appSlug) return (await isRepo(projectDir)) ? projectDir : null;
  // Reject any separator/traversal in the app slug — it is a single dir name.
  if (appSlug.includes("/") || appSlug.includes("\\") || appSlug.includes(".."))
    return null;
  const dir = path.join(projectDir, appSlug);
  if (path.dirname(dir) !== projectDir) return null;
  return (await isRepo(dir)) ? dir : null;
}

// ---------------------------------------------------------------------------
// git invocation
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[], maxBuffer = 1024 * 1024) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 10_000,
    maxBuffer,
  });
  return stdout;
}

function parseRefs(decoration: string): GitRef[] {
  if (!decoration.trim()) return [];
  return decoration
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((token): GitRef => {
      if (token.startsWith("tag: "))
        return { name: token.slice(5), kind: "tag" };
      if (token.startsWith("HEAD -> "))
        return { name: token.slice(8), kind: "head" };
      if (token === "HEAD") return { name: "HEAD", kind: "head" };
      if (token.includes("/")) return { name: token, kind: "remote" };
      return { name: token, kind: "branch" };
    });
}

/** Read up to LOG_LIMIT commits across all refs, newest first. */
async function readLog(repoDir: string): Promise<Commit[]> {
  const format = ["%H", "%P", "%D", "%an", "%aI", "%s"].join(US) + RS;
  const out = await git(repoDir, [
    "log",
    "--all",
    "--date-order",
    `--max-count=${LOG_LIMIT}`,
    `--pretty=format:${format}`,
  ]);
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    const line = record.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, parents, decoration, authorName, authorDate, subject] =
      line.split(US);
    if (!hash) continue;
    commits.push({
      hash,
      abbrev: hash.slice(0, 7),
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      refs: parseRefs(decoration ?? ""),
      authorName: authorName ?? "",
      authorDate: authorDate ?? "",
      subject: subject ?? "",
    });
  }
  return commits;
}

async function readStatus(repoDir: string): Promise<GitStatusFile[]> {
  let out: string;
  try {
    out = await git(repoDir, ["status", "--porcelain=v1"]);
  } catch {
    return [];
  }
  const files: GitStatusFile[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    // Porcelain path starts at col 3; a rename shows "old -> new" — keep new.
    const rest = line.slice(3);
    const p = rest.includes(" -> ") ? rest.split(" -> ")[1] : rest;
    files.push({
      code,
      path: p,
      staged: code[0] !== " " && code[0] !== "?",
      unstaged: code[1] !== " ",
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Lane assignment (pure — no I/O, exported for testing)
// ---------------------------------------------------------------------------

type Lane = { hash: string; color: number } | null;

function firstFree(lanes: Lane[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

/**
 * Assign each commit to a column and compute the edge segments between rows,
 * producing a renderable DAG. Commits must be newest-first (as `git log`
 * returns them). Pure: same input → same output, no dates/randomness.
 *
 * Model: `lanes[col]` holds the parent hash that column is currently routing
 * down toward. Walking top→bottom, a commit lands in the (leftmost) lane that
 * was waiting for it — or a fresh lane if it is a branch tip — then hands its
 * first parent back to that lane (mainline stays straight) and each extra
 * parent to a new lane (a merge fans out). Colors are stable per lane: a lane
 * keeps its colour as it flows down; new lanes take the next palette slot.
 */
export function assignLanes(commits: Commit[]): {
  rows: GraphRow[];
  columns: number;
} {
  const lanes: Lane[] = [];
  // Column each active lane emanates from at the TOP of the current gap: the
  // parent commit's column for a lane just opened by a branch/merge, else the
  // lane's own column (a straight passthrough).
  const topAnchor: number[] = [];
  const rows: GraphRow[] = [];
  let colorCounter = 0;
  let maxColumns = 0;

  for (const commit of commits) {
    // Lanes that were waiting for this commit (its children's lines).
    const incoming: number[] = [];
    for (let k = 0; k < lanes.length; k++)
      if (lanes[k]?.hash === commit.hash) incoming.push(k);

    let column: number;
    let color: number;
    if (incoming.length) {
      column = incoming[0];
      color = lanes[column]!.color;
    } else {
      column = firstFree(lanes);
      color = colorCounter++;
    }

    // Edges in the gap above this row. Each active lane runs from its top
    // anchor (where it left the previous row) down to its column here — or to
    // `column` when it is one of the lines converging into this commit.
    const edgesAbove: GraphRow["edgesAbove"] = [];
    for (let k = 0; k < lanes.length; k++) {
      const lane = lanes[k];
      if (!lane) continue;
      const bottom = lane.hash === commit.hash ? column : k;
      edgesAbove.push({ top: topAnchor[k], bottom, color: lane.color });
    }

    // Retire every incoming lane, then re-open the commit's own column for its
    // first parent so linear history draws as one unbroken vertical line.
    for (const k of incoming) lanes[k] = null;
    if (column >= lanes.length) lanes.length = column + 1;

    const [firstParent, ...extraParents] = commit.parents;
    lanes[column] = firstParent ? { hash: firstParent, color } : null;
    // Lanes opened by this commit emanate from its dot; existing passthrough
    // lanes now continue straight from their own column.
    for (let k = 0; k < lanes.length; k++)
      if (lanes[k]) topAnchor[k] = k;
    if (firstParent) topAnchor[column] = column;

    for (const parent of extraParents) {
      // Fan into an existing lane already heading to this parent if one exists
      // (a shared ancestor), otherwise open a new coloured lane for the merge.
      if (lanes.some((l) => l?.hash === parent)) continue;
      const nk = firstFree(lanes);
      if (nk >= lanes.length) lanes.length = nk + 1;
      lanes[nk] = { hash: parent, color: colorCounter++ };
      topAnchor[nk] = column; // the merge line branches off this commit's dot
    }

    rows.push({ commit, column, color, edgesAbove });
    maxColumns = Math.max(maxColumns, lanes.length, column + 1);
  }

  return { rows, columns: maxColumns };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Full graph payload for a repo: branch, placed rows, working-tree status. */
export async function getGraph(repoDir: string): Promise<GitGraph> {
  const [branch, commits, status] = await Promise.all([
    git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      .then((s) => s.trim() || null)
      .catch(() => null),
    readLog(repoDir),
    readStatus(repoDir),
  ]);
  const { rows, columns } = assignLanes(commits);
  return {
    branch,
    columns,
    rows,
    status,
    truncated: commits.length >= LOG_LIMIT,
  };
}

export type CommitDiff = {
  hash: string;
  /** Raw unified `git show` patch (no color), for the diff viewer. */
  patch: string;
};

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * The full patch for one commit (`git show`). `hash` is validated as a hex sha
 * so it can never smuggle extra args into the git invocation.
 */
export async function getCommitDiff(
  repoDir: string,
  hash: string,
): Promise<CommitDiff | null> {
  if (!SHA_RE.test(hash)) return null;
  try {
    const patch = await git(
      repoDir,
      ["show", "--no-color", "--format=fuller", hash],
      DIFF_MAX_BUFFER,
    );
    return { hash, patch };
  } catch {
    return null;
  }
}

export { PROJECTS_ROOT };
