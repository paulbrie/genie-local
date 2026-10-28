import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * How much disk each project folder under PROJECTS_ROOT takes, split into what
 * can be thrown away and rebuilt (dependencies, build output) and what can't (git
 * history, everything else). Space on disk (du's blocks, not apparent sizes), one
 * filesystem. A scan takes a couple of seconds, so it's cached for a while.
 */
const ROOT = process.env.PROJECTS_ROOT ?? "/opt/project/projects";
const FRESH_MS = 10 * 60_000;

export type DiskPart = "deps" | "build" | "git" | "other";
export type ProjectDisk = { name: string; bytes: number; parts: Record<DiskPart, number> };
export type DiskUsage = { root: string; scannedAt: number; projects: ProjectDisk[]; totalBytes: number };

/** Folder names and what they count as; a match isn't looked inside (so node_modules' own dist is deps). */
const KINDS: [RegExp, Exclude<DiskPart, "other">][] = [
  [/^node_modules$/, "deps"],
  [/^\.git$/, "git"],
  [/^(\.next(-.*)?|dist|\.turbo|\.cache|\.parcel-cache|\.svelte-kit|\.nuxt|\.output)$/, "build"],
];
const kindOf = (name: string) => KINDS.find(([re]) => re.test(name))?.[1] ?? null;

/**
 * du's figure in bytes for each path (one du run for many paths). du counts a file once per run, so paths inside
 * one another must go to separate runs (the projects, then the folders inside them), or the inner ones read as 0.
 */
async function duBytes(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // (in chunks: an argument list has a limit)
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    let stdout = "";
    try {
      ({ stdout } = await pexec("du", ["-sxB1", "--", ...chunk], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }));
    } catch (e) {
      // du exits non-zero on an unreadable file but still prints what it could
      stdout = (e as { stdout?: string }).stdout ?? "";
    }
    for (const line of stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) out.set(line.slice(tab + 1), Number(line.slice(0, tab)));
    }
  }
  return out;
}

/** The dependency / build / git folders inside a project, not looking inside any of them. */
async function special(dir: string): Promise<string[]> {
  const prune = ["node_modules", ".git", ".next", ".next-*", "dist", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", ".nuxt", ".output"];
  const expr = prune.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  try {
    const { stdout } = await pexec("find", [dir, "-xdev", "-mindepth", "1", "-type", "d", "(", ...expr, ")", "-prune", "-print0"], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout.split("\0").filter(Boolean);
  } catch (e) {
    return ((e as { stdout?: string }).stdout ?? "").split("\0").filter(Boolean);
  }
}

async function scan(): Promise<DiskUsage> {
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(ROOT, e.name));
  const inner = await Promise.all(dirs.map(special));
  const [totals, sizes] = await Promise.all([duBytes(dirs), duBytes(inner.flat())]);
  const projects = dirs.map((dir, i): ProjectDisk => {
    const parts: Record<DiskPart, number> = { deps: 0, build: 0, git: 0, other: 0 };
    for (const p of inner[i]) {
      const kind = kindOf(path.basename(p));
      if (kind) parts[kind] += sizes.get(p) ?? 0;
    }
    const bytes = totals.get(dir) ?? 0;
    parts.other = Math.max(0, bytes - parts.deps - parts.build - parts.git);
    return { name: path.basename(dir), bytes, parts };
  });
  projects.sort((a, b) => b.bytes - a.bytes);
  return { root: ROOT, scannedAt: Date.now(), projects, totalBytes: projects.reduce((n, p) => n + p.bytes, 0) };
}

const g = globalThis as typeof globalThis & { __diskUsage?: { last: DiskUsage | null; pending: Promise<DiskUsage> | null } };
const cache = (g.__diskUsage ??= { last: null, pending: null });

/** The latest scan, at most FRESH_MS old (or a new one with `fresh`); one scan at a time. */
export async function projectDiskUsage(fresh = false): Promise<DiskUsage> {
  if (!fresh && cache.last && Date.now() - cache.last.scannedAt < FRESH_MS) return cache.last;
  cache.pending ??= scan()
    .then((u) => (cache.last = u))
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}
