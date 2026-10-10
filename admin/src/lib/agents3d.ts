import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getCommsModel, repoFor, type RepoInfo } from "@/lib/claude-comms";
import type { Agents3DModel, AgentEvent, RepoLayout } from "@/lib/agents3d-types";
import { inHiddenDir, withoutHiddenDirs } from "@/lib/hidden-dirs";

/**
 * Data for the 3D agents views: the comms model, each session's tool calls
 * mapped onto repo-relative paths, and the layout (tracked files + sizes,
 * uncommitted files) of every repo the sessions work in. Paths outside a git
 * repo are dropped; tool inputs other than Edit/Write/Read file paths never
 * reach this module. Files in hidden folders (.next/, src/.cache/…) are left
 * out of the layouts unless asked for (lib/hidden-dirs.ts), before the
 * MAX_FILES cap, so they never crowd out the rest.
 */

const execFileAsync = promisify(execFile);

const MAX_REPOS = 6;
const MAX_FILES = 8000;
const MAX_UNTRACKED = 400;
const STATUS_TTL = 5_000;

/** Every tracked file at HEAD (the cap is applied per request, after the hidden-folder filter). */
type LayoutCache = { head: string; files: RepoLayout["files"] };
const treeCache = new Map<string, LayoutCache>();
type StatusCache = { at: number; dirty: RepoLayout["dirty"]; untracked: RepoLayout["files"]; untrackedHidden: RepoLayout["files"] };
const statusCache = new Map<string, StatusCache>();
const dirRepo = new Map<string, RepoInfo | null>();

async function repoOfFile(file: string): Promise<RepoInfo | null> {
  const dir = path.dirname(file);
  if (dirRepo.has(dir)) return dirRepo.get(dir)!;
  let info: RepoInfo | null = null;
  try {
    await fs.access(dir);
    info = await repoFor(dir);
  } catch {
    info = null;
  }
  dirRepo.set(dir, info);
  return info;
}

async function git(top: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", top, ...args], { maxBuffer });
  return stdout;
}

async function trackedFiles(top: string): Promise<LayoutCache> {
  let head = "";
  try {
    head = (await git(top, ["rev-parse", "HEAD"])).trim();
  } catch {
    return { head: "", files: [] };
  }
  const cached = treeCache.get(top);
  if (cached && cached.head === head) return cached;
  const files: RepoLayout["files"] = [];
  try {
    // "<mode> <type> <hash> <size>\t<path>\0"
    const out = await git(top, ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]);
    for (const rec of out.split("\0")) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") continue;
      files.push({ p: rec.slice(tab + 1), s: Number(meta[3]) || 0 });
    }
  } catch {
    /* empty layout */
  }
  files.sort((a, b) => a.p.localeCompare(b.p));
  const layout = { head, files };
  treeCache.set(top, layout);
  return layout;
}

async function repoStatus(top: string): Promise<StatusCache> {
  const c = statusCache.get(top);
  if (c && Date.now() - c.at < STATUS_TTL) return c;
  const dirty: RepoLayout["dirty"] = [];
  const untracked: RepoLayout["files"] = [];
  // (kept apart, each with its own cap, so an untracked hidden folder can't use up the shown files' share)
  const untrackedHidden: RepoLayout["files"] = [];
  try {
    const out = await git(top, ["status", "--porcelain=v1", "-z", "-uall"]);
    const recs = out.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.length < 4) continue;
      const code = rec.slice(0, 2);
      const p = rec.slice(3);
      if (code[0] === "R" || code[0] === "C") i++; // the next record is the old path
      if (dirty.length >= MAX_FILES) continue;
      try {
        const st = await fs.stat(path.join(top, p));
        dirty.push({ p, m: Math.round(st.mtimeMs) });
        const list = inHiddenDir(p) ? untrackedHidden : untracked;
        if (code === "??" && list.length < MAX_UNTRACKED) list.push({ p, s: st.size });
      } catch {
        dirty.push({ p, m: 0 }); // deleted
      }
    }
  } catch {
    /* not a repo any more */
  }
  const entry = { at: Date.now(), dirty, untracked, untrackedHidden };
  statusCache.set(top, entry);
  return entry;
}

export async function getAgents3DModel(days: number, { showHidden = false }: { showHidden?: boolean } = {}): Promise<Agents3DModel> {
  const comms = await getCommsModel(days, { activity: true });
  const { activity: rawActivity = {}, ...commsRest } = comms;

  // Map tool calls onto repos; count work per repo to pick which to lay out.
  const weight = new Map<string, number>();
  const repos = new Map<string, RepoInfo>();
  const activity: Record<string, AgentEvent[]> = {};
  for (const [key, events] of Object.entries(rawActivity)) {
    const out: AgentEvent[] = [];
    for (const e of events) {
      let repo: RepoInfo | null = null;
      let rel: string | null = null;
      if (e.file && path.isAbsolute(e.file)) {
        repo = await repoOfFile(e.file);
        if (repo) {
          rel = path.relative(repo.top, e.file);
          if (rel.startsWith("..")) [repo, rel] = [null, null];
        }
      }
      if (repo) {
        repos.set(repo.top, repo);
        weight.set(repo.top, (weight.get(repo.top) ?? 0) + 1);
      }
      out.push({ t: e.t, tool: e.tool, repo: repo?.top ?? null, path: rel });
    }
    activity[key] = out;
  }
  const nodeRepos: Record<string, string> = {};
  for (const n of comms.nodes) {
    if (!n.cwd) continue;
    const repo = await repoFor(n.cwd).catch(() => null);
    if (repo) {
      nodeRepos[n.key] = repo.top;
      repos.set(repo.top, repo);
      weight.set(repo.top, (weight.get(repo.top) ?? 0) + 50);
    }
  }
  const chosen = [...repos.values()]
    .sort((a, b) => (weight.get(b.top) ?? 0) - (weight.get(a.top) ?? 0))
    .slice(0, MAX_REPOS);

  const layouts: RepoLayout[] = [];
  for (const r of chosen) {
    const [tree, status] = await Promise.all([trackedFiles(r.top), repoStatus(r.top)]);
    const tracked = withoutHiddenDirs(tree.files, showHidden);
    const known = new Set(tracked.map((f) => f.p));
    const untracked = showHidden ? [...status.untracked, ...status.untrackedHidden] : status.untracked;
    layouts.push({
      id: r.top,
      name: r.project ? (r.app ? `${r.project}/${r.app}` : r.project) : path.basename(r.top),
      project: r.project,
      app: r.app,
      files: [...tracked.slice(0, MAX_FILES), ...untracked.filter((f) => !known.has(f.p))],
      dirty: withoutHiddenDirs(status.dirty, showHidden),
      truncated: tracked.length > MAX_FILES,
    });
  }

  const reposVersion = createHash("sha1")
    .update((showHidden ? "dot|" : "") + layouts.map((l) => `${l.id}:${treeCache.get(l.id)?.head}:${l.dirty.map((d) => `${d.p}@${d.m}`).join(",")}`).join("|"))
    .digest("hex")
    .slice(0, 12);

  return {
    version: `${comms.version}.${reposVersion}`,
    reposVersion,
    comms: commsRest,
    activity,
    repos: layouts,
    nodeRepos,
  };
}
