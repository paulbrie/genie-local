import "server-only";

import { execFile } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AppSignals,
  GitSignals,
  FsSignals,
  ProjectSignals,
} from "@/lib/types";

export type { AppSignals, ProjectSignals };

const execFileAsync = promisify(execFile);

export const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? "/opt/project/projects";

/**
 * Resolve a project directory from a slug, guarding against path traversal:
 * the resolved path must be a direct child of PROJECTS_ROOT.
 */
export function resolveProjectPath(slug: string): string {
  const root = path.resolve(PROJECTS_ROOT);
  const resolved = path.resolve(root, slug);
  if (path.dirname(resolved) !== root) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  return resolved;
}

/** List the direct child directories of PROJECTS_ROOT (the projects). */
export async function discoverProjectSlugs(): Promise<string[]> {
  const root = path.resolve(PROJECTS_ROOT);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A directory is an "app" if it has a repo or a package manifest. */
async function isApp(dir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(dir, ".git"))) ||
    (await pathExists(path.join(dir, "package.json")))
  );
}

async function firstExisting(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    if (await pathExists(path.join(dir, n))) return true;
  }
  return false;
}

/**
 * Discover the apps inside a project directory (depth 1). If the project dir is
 * itself an app, it is the single app with slug ''. Otherwise, each immediate
 * subdirectory that is an app becomes one (e.g. roa/server-app, roa/server-admin).
 */
async function discoverApps(
  projectDir: string,
): Promise<Array<{ slug: string; path: string }>> {
  if (await isApp(projectDir)) {
    return [{ slug: "", path: projectDir }];
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const apps: Array<{ slug: string; path: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") {
      continue;
    }
    const child = path.join(projectDir, e.name);
    if (await isApp(child)) apps.push({ slug: e.name, path: child });
  }
  apps.sort((a, b) => a.slug.localeCompare(b.slug));
  return apps;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort recursive byte size of a directory. Skips node_modules and .git
 * so a huge dependency tree doesn't dominate the walk.
 */
async function dirSize(dir: string): Promise<number | null> {
  const SKIP = new Set(["node_modules", ".git"]);
  let total = 0;
  async function walk(d: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          const st = await fs.stat(full);
          total += st.size;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  try {
    await walk(dir);
    return total;
  } catch {
    return null;
  }
}

async function readPackageJson(dir: string) {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(parsed.dependencies ?? {}).length;
    const devDeps = Object.keys(parsed.devDependencies ?? {}).length;
    return {
      name: parsed.name ?? null,
      scripts: Object.keys(parsed.scripts ?? {}),
      dependencyCount: deps + devDeps,
    };
  } catch {
    return { name: null, scripts: [], dependencyCount: null };
  }
}

/**
 * Full `package.json` scripts (name → command) for an app dir. Guarded to
 * PROJECTS_ROOT; returns {} if the dir is outside, missing, or unparseable.
 */
export async function readScripts(
  dir: string,
): Promise<Record<string, string>> {
  const root = path.resolve(PROJECTS_ROOT);
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return {};
  try {
    const raw = await fs.readFile(
      path.join(resolved, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function emptyGit(): GitSignals {
  return {
    branch: null,
    dirty: null,
    dirtyCount: null,
    ahead: null,
    behind: null,
    lastCommitHash: null,
    lastCommitAt: null,
  };
}

function emptyFs(): FsSignals {
  return {
    dirMtime: null,
    sizeBytes: null,
    hasPackageJson: false,
    hasEnv: false,
    hasReadme: false,
    hasDockerfile: false,
  };
}

/** Collect all signals for a single app directory. Never throws. */
async function collectApp(slug: string, dir: string): Promise<AppSignals> {
  const errors: string[] = [];
  const isGit = await pathExists(path.join(dir, ".git"));

  // --- git signals ---
  const gitSignals = emptyGit();
  if (isGit) {
    try {
      gitSignals.branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

      const porcelain = await git(dir, ["status", "--porcelain"]);
      if (porcelain !== null) {
        const lines = porcelain.length
          ? porcelain.split("\n").filter(Boolean)
          : [];
        gitSignals.dirtyCount = lines.length;
        gitSignals.dirty = lines.length > 0;
      }

      const last = await git(dir, ["log", "-1", "--format=%H|%cI"]);
      if (last) {
        const [hash, iso] = last.split("|");
        gitSignals.lastCommitHash = hash ?? null;
        gitSignals.lastCommitAt = iso ?? null;
      }

      const counts = await git(dir, [
        "rev-list",
        "--left-right",
        "--count",
        "@{u}...HEAD",
      ]);
      if (counts) {
        const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n));
        gitSignals.behind = Number.isFinite(behind) ? behind : null;
        gitSignals.ahead = Number.isFinite(ahead) ? ahead : null;
      }
    } catch (e) {
      errors.push(`git: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- filesystem signals ---
  const fsSignals = emptyFs();
  try {
    const st = await fs.stat(dir);
    fsSignals.dirMtime = st.mtime.toISOString();
    fsSignals.hasPackageJson = await pathExists(path.join(dir, "package.json"));
    fsSignals.hasEnv = await pathExists(path.join(dir, ".env"));
    fsSignals.hasReadme = await firstExisting(dir, [
      "README.md",
      "README",
      "readme.md",
    ]);
    fsSignals.hasDockerfile = await pathExists(path.join(dir, "Dockerfile"));
    fsSignals.sizeBytes = await dirSize(dir);
  } catch (e) {
    errors.push(`fs: ${e instanceof Error ? e.message : String(e)}`);
  }

  const pkg = await readPackageJson(dir);

  return {
    slug,
    path: dir,
    name: pkg.name,
    isGit,
    git: gitSignals,
    fs: fsSignals,
    pkg,
    errors,
  };
}

/** Collect signals for a project (its directory + all discovered apps). */
export async function collectProject(slug: string): Promise<ProjectSignals> {
  const dir = resolveProjectPath(slug);
  const appDirs = await discoverApps(dir);
  const apps = await Promise.all(
    appDirs.map(async ({ slug: appSlug, path: appPath }) => {
      try {
        return await collectApp(appSlug, appPath);
      } catch (e) {
        return {
          slug: appSlug,
          path: appPath,
          name: null,
          isGit: false,
          git: emptyGit(),
          fs: emptyFs(),
          pkg: { name: null, scripts: [], dependencyCount: null },
          errors: [String(e instanceof Error ? e.message : e)],
        } satisfies AppSignals;
      }
    }),
  );
  return { slug, path: dir, apps };
}

/** Collect signals for every discovered project. Isolated per-project. */
export async function collectAllProjects(): Promise<ProjectSignals[]> {
  const slugs = await discoverProjectSlugs();
  return Promise.all(
    slugs.map(async (slug) => {
      try {
        return await collectProject(slug);
      } catch {
        return {
          slug,
          path: path.join(PROJECTS_ROOT, slug),
          apps: [],
        } satisfies ProjectSignals;
      }
    }),
  );
}
