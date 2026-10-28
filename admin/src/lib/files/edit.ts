// The file explorer's editor (/files and a project's Files tab): a text file saved back in place. Only a file the
// preview shows whole (one text page, EDIT_MAX), valid UTF-8 without NULs, not a credential file (those stay
// read-only), inside the write roots. Saved atomically (a temp file beside it, renamed over it, its mode kept) and only
// if it is still what the page read (its hash), so a change made on disk meanwhile is refused (409), never overwritten.

import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import { assertWritable, fileRoots, isPseudo, PathError, resolveExisting, writeRoots } from "./guard";
import { isSecretPath } from "./listing";
import { TEXT_PAGE } from "./preview";

/** the most the editor opens or saves: one preview page */
export const EDIT_MAX = TEXT_PAGE;

export const hashOf = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** a file opened for editing: its text and the version a save must still find on disk */
export interface Editable {
  text: string;
  size: number;
  mtime: number;
  hash: string;
}

/** `abs` (resolved) as the editor would open it, or why it stays read-only */
export async function openForEdit(abs: string, writes: string[] = writeRoots()): Promise<Editable | { readOnly: string }> {
  if (isPseudo(abs)) return { readOnly: "a kernel file" };
  if (isSecretPath(abs)) return { readOnly: "a credential file: read-only here" };
  const st = await fs.stat(abs);
  if (!st.isFile()) return { readOnly: "not a regular file" };
  if (st.size > EDIT_MAX) return { readOnly: `too big to edit here (over ${EDIT_MAX / 1024 / 1024} MB)` };
  try {
    await assertWritable(abs, {}, writes);
  } catch (err) {
    if (err instanceof PathError) return { readOnly: err.message };
    throw err;
  }
  const writableHere = await Promise.all([fs.access(abs, constants.W_OK), fs.access(path.dirname(abs), constants.W_OK)]).then(() => true, () => false);
  if (!writableHere) return { readOnly: "permission denied (the admin runs as genie)" };
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) return { readOnly: "a binary file" };
  const text = buf.toString("utf8");
  // (bytes that aren't UTF-8 would come back changed even where nothing was edited)
  if (!Buffer.from(text, "utf8").equals(buf)) return { readOnly: "not UTF-8 text: saving it would change bytes that weren't edited" };
  return { text, size: buf.length, mtime: st.mtimeMs, hash: hashOf(buf) };
}

/**
 * Saves `content` over the file at `p`, if it still has the hash `expect` the page read (else 409, nothing written),
 * after the same checks as openForEdit. Returns the new version.
 */
export async function writeText(p: string, content: unknown, expect: string, roots = fileRoots(), writes?: string[]): Promise<Omit<Editable, "text"> & { path: string }> {
  if (typeof content !== "string") throw new PathError("no content");
  if (!expect) throw new PathError("no version: reload the file first");
  const t = await resolveExisting(p, roots);
  const data = Buffer.from(content, "utf8");
  if (data.length > EDIT_MAX) throw new PathError(`too big to save from here (over ${EDIT_MAX / 1024 / 1024} MB)`, 413);
  if (data.includes(0)) throw new PathError("the text has a NUL character: binary files aren't saved from here");
  const changed = () => new PathError("it changed on disk since it was opened, so it wasn't saved: reload it (copy your changes first)", 409);
  const cur = await openForEdit(t.abs, writes ?? writeRoots());
  if ("readOnly" in cur) throw new PathError(cur.readOnly, 403);
  if (cur.hash !== expect) throw changed();

  const mode = (await fs.stat(t.abs)).mode & 0o7777;
  const tmp = path.join(path.dirname(t.abs), `.${path.basename(t.abs).slice(0, 50)}.${randomBytes(6).toString("hex")}.save`);
  try {
    const fh = await fs.open(tmp, "wx", mode);
    try {
      await fh.writeFile(data);
      await fh.chmod(mode); // (open's mode is cut by the umask)
      await fh.sync();
    } finally {
      await fh.close();
    }
    // (a last look just before it lands: a change made meanwhile still wins over this save)
    if (hashOf(await fs.readFile(t.abs)) !== expect) throw changed();
    await fs.rename(tmp, t.abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  const st = await fs.stat(t.abs);
  return { path: t.abs, size: st.size, mtime: st.mtimeMs, hash: hashOf(data) };
}
