// The file explorer's trash (T243): a delete moves the item to <trash>/<id>/<name> with <trash>/<id>.json saying where
// it came from, so it can be restored; "Empty trash" removes them for good.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** ADMIN_FILES_TRASH, else /home/genie/.admin-trash */
export function trashDir(): string {
  return path.resolve(process.env.ADMIN_FILES_TRASH || "/home/genie/.admin-trash");
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: string;
  bytes: number;
  type: "dir" | "file" | "other";
}

/** a rename, or a copy then remove when the trash is on another disk */
async function moveAcross(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** moves `abs` to the trash; returns its entry */
export async function moveToTrash(abs: string, bytes: number, trash = trashDir()): Promise<TrashItem> {
  const st = await fs.lstat(abs);
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const item: TrashItem = {
    id,
    name: path.basename(abs),
    originalPath: abs,
    deletedAt: new Date().toISOString(),
    bytes,
    type: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
  };
  await fs.mkdir(path.join(trash, id), { recursive: true, mode: 0o700 });
  await moveAcross(abs, path.join(trash, id, item.name));
  await fs.writeFile(path.join(trash, `${id}.json`), JSON.stringify(item, null, 2));
  return item;
}

/** what is in the trash, newest first */
export async function listTrash(trash = trashDir()): Promise<TrashItem[]> {
  const names = await fs.readdir(trash).catch(() => [] as string[]);
  const items = await Promise.all(
    names.filter((n) => n.endsWith(".json")).map(async (n) => {
      try {
        return JSON.parse(await fs.readFile(path.join(trash, n), "utf8")) as TrashItem;
      } catch {
        return null;
      }
    }),
  );
  return items.filter((i): i is TrashItem => !!i).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

const ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;

/** puts an item back where it was; refuses when something is there now, or when its folder is gone */
export async function restoreFromTrash(id: string, trash = trashDir()): Promise<TrashItem> {
  if (!ID_RE.test(id)) throw new Error("bad trash id");
  const item = JSON.parse(await fs.readFile(path.join(trash, `${id}.json`), "utf8")) as TrashItem;
  const target = item.originalPath;
  if (await fs.lstat(target).then(() => true, () => false)) throw new Error(`something is at ${target} now`);
  if (!(await fs.stat(path.dirname(target)).then((s) => s.isDirectory(), () => false))) throw new Error(`its folder ${path.dirname(target)} is gone`);
  await moveAcross(path.join(trash, id, item.name), target);
  await fs.rm(path.join(trash, id), { recursive: true, force: true });
  await fs.rm(path.join(trash, `${id}.json`), { force: true });
  return item;
}

/** removes everything in the trash for good; returns how many items and bytes */
export async function emptyTrash(trash = trashDir()): Promise<{ items: number; bytes: number }> {
  const items = await listTrash(trash);
  for (const i of items) {
    await fs.rm(path.join(trash, i.id), { recursive: true, force: true });
    await fs.rm(path.join(trash, `${i.id}.json`), { force: true });
  }
  return { items: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) };
}
