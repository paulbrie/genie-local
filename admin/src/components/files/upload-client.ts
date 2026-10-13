"use client";

// The browser's side of uploads of any size (T243): a File sent in chunks (File.slice: never read whole into memory),
// each retried on a network error, the offset taken from the server when it says otherwise (409), and the server's
// session kept in localStorage per file so dropping the same file again after a reload resumes where it stopped.

import { BASE_PATH } from "@/lib/config";

export interface UploadProgress {
  sent: number;
  size: number;
}

const KEY = "admin.files.uploads";
/** the same file again: same folder, name, size and modification time */
const fileKey = (dir: string, file: File, name: string) => `${dir}\n${name}\n${file.size}\n${file.lastModified}`;
const remembered = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};
const remember = (k: string, id: string | null) => {
  const m = remembered();
  if (id) m[k] = id;
  else delete m[k];
  localStorage.setItem(KEY, JSON.stringify(m));
};

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
  });

/**
 * Uploads `file` as `name` into folder `dir`. Resumes a session this browser started for the same file; retries a chunk
 * up to 6 times (1, 2, 4… s apart), asking the server what it has after a failure; on `signal` abort, the server drops
 * the upload. Resolves with the file's path once it is in place.
 */
export async function uploadFile(
  file: File,
  dir: string,
  name: string,
  opts: { overwrite?: boolean; signal: AbortSignal; onProgress: (p: UploadProgress) => void },
): Promise<string> {
  const api = `${BASE_PATH}/api/files/upload`, key = fileKey(dir, file, name);
  let id: string | null = remembered()[key] ?? null, offset = 0, chunkBytes = 8 * 1024 * 1024;
  if (id) {
    const s = await fetch(`${api}/${id}`, { cache: "no-store" }).then((r) => (r.ok ? json<{ received: number; size: number }>(r) : null)).catch(() => null);
    if (s && s.size === file.size) offset = s.received;
    else id = null;
  }
  if (!id) {
    const s = await json<{ id: string; chunkBytes: number }>(await fetch(api, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: opts.signal,
      body: JSON.stringify({ dir, name, size: file.size, overwrite: !!opts.overwrite }),
    }));
    id = s.id;
    chunkBytes = s.chunkBytes;
    remember(key, id);
  }
  const cancel = () => { void fetch(`${api}/${id}`, { method: "DELETE" }); remember(key, null); };
  opts.signal.addEventListener("abort", cancel, { once: true });
  try {
    opts.onProgress({ sent: offset, size: file.size });
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`${api}/${id}?offset=${offset}`, { method: "PUT", body: chunk, signal: opts.signal, headers: { "Content-Type": "application/octet-stream" } });
          if (res.status === 409) {
            offset = ((await res.json()) as { received: number }).received;
            break;
          }
          offset = (await json<{ received: number }>(res)).received;
          break;
        } catch (err) {
          if (opts.signal.aborted || (err as { status?: number }).status === 404 || attempt >= 5) throw err;
          await sleep(1000 * 2 ** attempt, opts.signal);
          // (what the server has now: the chunk may have landed before the connection dropped)
          const s = await fetch(`${api}/${id}`, { cache: "no-store" }).then((r) => json<{ received: number }>(r)).catch(() => null);
          if (s) { offset = s.received; break; }
        }
      }
      opts.onProgress({ sent: offset, size: file.size });
    }
    const done = await json<{ path: string }>(await fetch(`${api}/${id}`, { method: "POST", signal: opts.signal }));
    remember(key, null);
    return done.path;
  } finally {
    opts.signal.removeEventListener("abort", cancel);
  }
}

/** a dropped item's files, folders walked, each with its path relative to the drop ("photos/2024/a.jpg") */
export async function filesOfDrop(items: DataTransferItemList): Promise<{ file: File; rel: string }[]> {
  const out: { file: File; rel: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: `${prefix}${entry.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // (readEntries gives a batch at a time: read until empty)
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  for (const e of entries) await walk(e, "");
  return out;
}
