import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { parseDuTop } from "@/lib/disk-overview-core";
import { PROJECTS_ROOT } from "@/lib/signals";

const execFileAsync = promisify(execFile);

/** An app's `.next` folder: Next's build output and its caches (`next dev`'s too, under .next/dev). */
export type NextDir = {
  path: string;
  exists: boolean;
  /** Bytes on disk, null when du couldn't tell. */
  bytes: number | null;
  /** Its biggest entries (dev, cache, server…). */
  top: { name: string; bytes: number }[];
};

/** The app dir, rejecting anything outside PROJECTS_ROOT. */
function appDir(dir: string): string {
  const root = path.resolve(PROJECTS_ROOT);
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("app directory is outside PROJECTS_ROOT");
  }
  return resolved;
}

const hasNext = (deps: unknown): deps is Record<string, unknown> =>
  !!deps && typeof deps === "object" && Object.hasOwn(deps, "next");

/** The version range of `next` the app's package.json asks for (dependencies or devDependencies); null: it doesn't. */
export async function nextDependency(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(appDir(dir), "package.json"), "utf8")) as {
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const deps = hasNext(pkg.dependencies) ? pkg.dependencies : hasNext(pkg.devDependencies) ? pkg.devDependencies : null;
    return deps ? String(deps.next) : null;
  } catch {
    return null;
  }
}

/** The app's `.next`: there or not, its size and biggest entries (du, one level deep). */
export async function nextDirInfo(dir: string): Promise<NextDir> {
  const target = path.join(appDir(dir), ".next");
  if (!(await fs.lstat(target).catch(() => null))) return { path: target, exists: false, bytes: null, top: [] };
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("du", ["-xB1", "--max-depth=1", "--", target], { timeout: 60_000 }));
  } catch (e) {
    // (du exits non-zero on a folder it may not read, having measured the rest)
    stdout = (e as { stdout?: string }).stdout ?? "";
  }
  const du = parseDuTop(stdout, target, 4);
  return { path: target, exists: true, bytes: du?.bytes ?? null, top: du?.top ?? [] };
}

/** Delete the app's `.next` (a symlink there goes, not what it points at). */
export async function removeNextDir(dir: string): Promise<void> {
  await fs.rm(path.join(appDir(dir), ".next"), { recursive: true, force: true });
}
