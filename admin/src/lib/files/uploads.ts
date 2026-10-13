// Uploads of any size (T243): the browser sends the file in chunks (CHUNK_BYTES, under the 10 MB a request body may be
// through the proxy), each written at its offset into a hidden temp file in the target folder; a dropped connection
// resumes from what the server has (`status`); the last step renames the temp file into place (atomic, same folder).
// Nothing holds the whole file in memory. Sessions are kept as small JSON files, so a restart of the admin resumes too.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** a chunk: 8 MiB (the proxy buffers request bodies up to 10 MB) */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** free space kept on top of the file's size */
export const SPARE_BYTES = 1024 ** 3;
/** a session not finished after this is cleared */
const STALE_MS = 24 * 60 * 60 * 1000;

export interface UploadSession {
  id: string;
  dir: string;
  name: string;
  size: number;
  received: number;
  tmp: string;
  overwrite: boolean;
  createdAt: string;
}

/** ADMIN_FILES_UPLOADS, else /home/genie/.admin-uploads (session state only; the data goes to the target folder) */
export function uploadsDir(): string {
  return path.resolve(process.env.ADMIN_FILES_UPLOADS || "/home/genie/.admin-uploads");
}

const ID_RE = /^[0-9a-f-]{36}$/;
const statePath = (id: string, dir: string) => {
  if (!ID_RE.test(id)) throw new UploadError("bad upload id", 400);
  return path.join(dir, `${id}.json`);
};

export class UploadError extends Error {
  constructor(message: string, readonly status: number, readonly received?: number) {
    super(message);
  }
}

async function save(s: UploadSession, dir: string): Promise<void> {
  const p = statePath(s.id, dir), tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, p);
}

export async function getSession(id: string, dir = uploadsDir()): Promise<UploadSession> {
  try {
    return JSON.parse(await fs.readFile(statePath(id, dir), "utf8")) as UploadSession;
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError("no such upload", 404);
  }
}

/** free bytes on the disk holding `p` */
export async function freeBytes(p: string): Promise<number> {
  const s = await fs.statfs(p);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Starts an upload of `size` bytes as `final` (already path-checked by the caller): refuses when the disk hasn't room
 * (size + SPARE_BYTES) or when the file exists (unless `overwrite`); creates the temp file.
 */
export async function startUpload(final: string, size: number, overwrite: boolean, dir = uploadsDir(), free: (p: string) => Promise<number> = freeBytes): Promise<UploadSession> {
  if (!Number.isSafeInteger(size) || size < 0) throw new UploadError("bad size", 400);
  const target = path.dirname(final);
  const room = await free(target);
  if (room < size + SPARE_BYTES) throw new UploadError(`not enough room: ${size} bytes asked, ${room} free (keeping ${SPARE_BYTES} spare)`, 507);
  if (!overwrite && (await fs.lstat(final).then(() => true, () => false))) throw new UploadError("a file with that name is already there", 409);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await clearStale(dir);
  const id = randomUUID();
  const s: UploadSession = {
    id, dir: target, name: path.basename(final), size, received: 0,
    tmp: path.join(target, `.${path.basename(final)}.${id.slice(0, 8)}.part`), overwrite, createdAt: new Date().toISOString(),
  };
  await fs.writeFile(s.tmp, "", { flag: "wx" });
  await save(s, dir);
  return s;
}

/**
 * Writes a chunk at `offset`. The next chunk must start at what the server has: an earlier one (a retry) is taken as
 * already there; a later one is refused (409, with what the server has, so the browser resumes from there).
 */
export async function writeChunk(id: string, offset: number, chunk: Uint8Array, dir = uploadsDir()): Promise<UploadSession> {
  const s = await getSession(id, dir);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new UploadError("bad offset", 400);
  if (chunk.byteLength > CHUNK_BYTES) throw new UploadError("chunk too big", 413);
  if (offset + chunk.byteLength > s.size) throw new UploadError("past the file's end", 400);
  if (offset !== s.received) {
    if (offset + chunk.byteLength <= s.received) return s;
    throw new UploadError("out of order", 409, s.received);
  }
  const fh = await fs.open(s.tmp, "r+");
  try {
    let done = 0;
    while (done < chunk.byteLength) {
      const { bytesWritten } = await fh.write(chunk, done, chunk.byteLength - done, offset + done);
      done += bytesWritten;
    }
  } finally {
    await fh.close();
  }
  s.received += chunk.byteLength;
  await save(s, dir);
  return s;
}

/** Puts the finished file in place: its size checked, then renamed over the name (atomic: same folder). */
export async function completeUpload(id: string, dir = uploadsDir()): Promise<{ path: string; size: number }> {
  const s = await getSession(id, dir);
  const st = await fs.stat(s.tmp).catch(() => null);
  if (!st || s.received !== s.size || st.size !== s.size) throw new UploadError(`incomplete: ${s.received} of ${s.size} bytes`, 409, s.received);
  const final = path.join(s.dir, s.name);
  if (!s.overwrite && (await fs.lstat(final).then(() => true, () => false))) throw new UploadError("a file with that name is already there", 409);
  await fs.rename(s.tmp, final);
  await fs.rm(statePath(id, dir), { force: true });
  return { path: final, size: s.size };
}

/** Drops an upload: its temp file and state. */
export async function cancelUpload(id: string, dir = uploadsDir()): Promise<void> {
  const s = await getSession(id, dir).catch(() => null);
  if (s) await fs.rm(s.tmp, { force: true });
  await fs.rm(statePath(id, dir), { force: true });
}

/** sessions older than STALE_MS: their temp files and state removed */
export async function clearStale(dir = uploadsDir(), now = Date.now()): Promise<number> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let n = 0;
  for (const name of names.filter((x) => x.endsWith(".json"))) {
    const s = await getSession(name.slice(0, -5), dir).catch(() => null);
    if (s && now - Date.parse(s.createdAt) > STALE_MS) {
      await cancelUpload(s.id, dir);
      n++;
    }
  }
  return n;
}
