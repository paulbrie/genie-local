// The file explorer's changes (T243): new folder, rename, move, delete (to the trash), each path-checked and written
// to the server log as an audit line (who, what, which path, how big; never a file's contents).

import { promises as fs } from "node:fs";
import path from "node:path";

import { checkName, fileRoots, isWithin, PathError, resolveExisting, resolveNew } from "./guard";
import { folderSize, runningInside } from "./listing";
import { moveToTrash, trashDir, type TrashItem } from "./trash";

/** an audit line in the server log (journalctl -u admin.service): never a file's contents */
export function audit(action: string, fields: Record<string, string | number | boolean | undefined>, who: string): void {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`[files] ${action} by=${JSON.stringify(who)} ${parts.join(" ")}`);
}

export async function makeFolder(dir: string, name: string, roots = fileRoots()): Promise<string> {
  const t = await resolveNew(dir, name, roots);
  await fs.mkdir(t.abs);
  return t.abs;
}

/** renames in place (same folder) */
export async function renamePath(p: string, newName: string, roots = fileRoots()): Promise<string> {
  const from = await resolveExisting(p, roots);
  if (from.abs === from.root) throw new PathError("a root can't be renamed", 403);
  const to = await resolveNew(path.dirname(from.abs), checkName(newName), roots);
  await fs.rename(from.abs, to.abs);
  return to.abs;
}

/** moves into another folder (inside the roots; not into itself) */
export async function movePath(p: string, toDir: string, roots = fileRoots()): Promise<string> {
  const from = await resolveExisting(p, roots);
  if (from.abs === from.root) throw new PathError("a root can't be moved", 403);
  const to = await resolveNew(toDir, path.basename(from.abs), roots);
  if (isWithin(to.abs, from.abs)) throw new PathError("can't move a folder into itself", 400);
  try {
    await fs.rename(from.abs, to.abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(from.abs, to.abs, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.rm(from.abs, { recursive: true, force: true });
  }
  return to.abs;
}

export interface DeletePlan {
  path: string;
  type: "dir" | "file" | "other";
  bytes: number;
  files: number;
  truncated: boolean;
  /** processes the admin runs inside it: deleting needs `force` */
  running: { slug: string; pid: number }[];
}

/**
 * What a delete would take (for its confirm), or why it's refused: a root, a .git folder itself, anything in the
 * trash (restore or empty it instead).
 */
export async function planDelete(p: string, roots = fileRoots(), runDir?: string): Promise<DeletePlan> {
  const t = await resolveExisting(p, roots);
  if (t.abs === t.root) throw new PathError("a root can't be deleted", 403);
  if (path.basename(t.abs) === ".git") throw new PathError("a repository's .git folder can't be deleted from here", 403);
  const trash = await fs.realpath(trashDir()).catch(() => trashDir());
  if (isWithin(t.abs, trash)) throw new PathError("in the trash: restore it or empty the trash", 403);
  const st = await fs.lstat(t.abs);
  const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  const size = type === "dir" ? await folderSize(t.abs) : { bytes: st.size, files: 1, truncated: false };
  const running = type === "dir" ? (await runningInside(t.abs, runDir)).map(({ slug, pid }) => ({ slug, pid })) : [];
  return { path: t.abs, type, ...size, running };
}

/** deletes to the trash, after the same checks as planDelete; a folder with running processes needs `force` */
export async function deletePath(p: string, force: boolean, roots = fileRoots(), runDir?: string): Promise<TrashItem> {
  const plan = await planDelete(p, roots, runDir);
  if (plan.running.length && !force) {
    throw new PathError(`running inside it: ${plan.running.map((r) => r.slug).join(", ")} (confirm again to delete anyway)`, 409);
  }
  return moveToTrash(plan.path, plan.bytes);
}
