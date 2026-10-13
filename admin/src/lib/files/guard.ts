// The file explorer's path guard (T243): every path the explorer touches is resolved (realpath: no "..", no symlink
// leading out) and must stay inside one of its roots. Used by the /api/files routes only (it reads the disk; no
// "server-only" import so its tests can run under node).

import { promises as fs } from "node:fs";
import path from "node:path";

/** The roots the explorer may see: ADMIN_FILES_ROOTS (comma-separated), else /opt/project and /home/genie. */
export function fileRoots(): string[] {
  const env = process.env.ADMIN_FILES_ROOTS;
  const list = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : ["/opt/project", "/home/genie"];
  return list.map((r) => path.resolve(r));
}

/** true when `p` is `root` or inside it (both already resolved) */
export function isWithin(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class PathError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** the root `p` is in, or null */
export function rootOf(p: string, roots: string[]): string | null {
  return roots.find((r) => isWithin(p, r)) ?? null;
}

/**
 * An existing path, resolved (realpath) and inside a root; throws PathError otherwise. The roots themselves are
 * realpath'd too, so a root that is a symlink still works.
 */
export async function resolveExisting(p: string, roots: string[] = fileRoots()): Promise<{ abs: string; root: string }> {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new PathError("bad path");
  let abs: string;
  try {
    abs = await fs.realpath(path.resolve(p));
  } catch {
    throw new PathError("not found", 404);
  }
  const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r)));
  const root = rootOf(abs, realRoots);
  if (!root) throw new PathError("outside the explorer's roots", 403);
  return { abs, root };
}

/** a single path segment for a new name: no separators, no "." or "..", no NUL, not too long */
export function checkName(name: string): string {
  if (typeof name !== "string") throw new PathError("bad name");
  const n = name.trim();
  if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\\") || n.includes("\0") || Buffer.byteLength(n) > 255) {
    throw new PathError("bad name");
  }
  return n;
}

/** a new path `name` inside existing directory `dir` (both checked); the new path must not exist yet unless `allowExisting` */
export async function resolveNew(dir: string, name: string, roots: string[] = fileRoots(), allowExisting = false): Promise<{ abs: string; dir: string; root: string }> {
  const parent = await resolveExisting(dir, roots);
  const stat = await fs.stat(parent.abs);
  if (!stat.isDirectory()) throw new PathError("not a folder");
  const abs = path.join(parent.abs, checkName(name));
  if (!allowExisting) {
    const exists = await fs.lstat(abs).then(() => true, () => false);
    if (exists) throw new PathError("already exists", 409);
  }
  return { abs, dir: parent.abs, root: parent.root };
}
