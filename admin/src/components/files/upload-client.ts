"use client";

// The browser's side of uploads of any size (T243): a File sent in chunks (File.slice: never read whole into memory),
// PARALLEL of them at once (a link that holds each connection back goes as many times faster), each retried on a
// network error, and the server's session kept in localStorage per file so dropping the same file again after a
// reload resumes with only the chunks the server doesn't have.

import { BASE_PATH } from "@/lib/config";

export interface UploadProgress {
  sent: number;
  size: number;
  /** bytes per second over the last few seconds; null until there is enough to measure */
  bytesPerSec: number | null;
}

const KEY = "admin.files.uploads";
/** chunks in flight at once (the browser's connections to a host are 6: some kept for the rest of the page) */
const PARALLEL = 4;
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
 * A chunk's PUT through XMLHttpRequest, which (unlike fetch) reports the bytes sent as they go: `onSent` gets the
 * chunk's bytes so far. Resolves with the status and JSON body; rejects on a network error or `signal` abort.
 */
function putChunk(url: string, chunk: Blob, signal: AbortSignal, onSent: (loaded: number) => void) {
  return new Promise<{ status: number; body: { received?: number; error?: string } }>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("cancelled", "AbortError"));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON: the status says enough */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new TypeError("network error"));
    xhr.onabort = () => reject(new DOMException("cancelled", "AbortError"));
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(chunk);
  });
}

/**
 * Progress as it happens, at most every 250 ms (`force` for the start and each chunk's end), with the speed over the
 * last 3 s. A retry can send bytes again, so the window restarts when `sent` goes back.
 */
function progressMeter(size: number, onProgress: (p: UploadProgress) => void) {
  let samples: { t: number; sent: number }[] = [], lastEmit = 0;
  return (sent: number, force = false) => {
    const t = performance.now();
    if (samples.length && sent < samples[samples.length - 1].sent) samples = [];
    samples.push({ t, sent });
    while (samples.length > 2 && t - samples[1].t >= 3000) samples.shift();
    if (!force && t - lastEmit < 250) return;
    lastEmit = t;
    const first = samples[0], span = (t - first.t) / 1000;
    onProgress({ sent, size, bytesPerSec: span >= 0.5 ? (sent - first.sent) / span : null });
  };
}

/**
 * Uploads `file` as `name` into folder `dir`, PARALLEL chunks at once. Resumes a session this browser started for the
 * same file (sending only the chunks the server hasn't); retries a chunk up to 6 times (1, 2, 4… s apart: a chunk sent
 * twice is taken as there); on `signal` abort, or a chunk that can't be sent, the others stop and the server drops the
 * upload. Resolves with the file's path once it is in place.
 */
export async function uploadFile(
  file: File,
  dir: string,
  name: string,
  opts: { overwrite?: boolean; project?: string; signal: AbortSignal; onProgress: (p: UploadProgress) => void },
): Promise<string> {
  const api = `${BASE_PATH}/api/files/upload`, key = fileKey(dir, file, name);
  let id: string | null = remembered()[key] ?? null, chunkBytes = 8 * 1024 * 1024, have: number[] = [];
  if (id) {
    const s = await fetch(`${api}/${id}`, { cache: "no-store" })
      .then((r) => (r.ok ? json<{ received: number; size: number; chunkBytes: number; chunks: number[] }>(r) : null))
      .catch(() => null);
    if (s && s.size === file.size) [chunkBytes, have] = [s.chunkBytes, s.chunks];
    else id = null;
  }
  if (!id) {
    const s = await json<{ id: string; chunkBytes: number }>(await fetch(api, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: opts.signal,
      body: JSON.stringify({ dir, name, size: file.size, overwrite: !!opts.overwrite, project: opts.project }),
    }));
    id = s.id;
    chunkBytes = s.chunkBytes;
    remember(key, id);
  }
  const cancel = () => { void fetch(`${api}/${id}`, { method: "DELETE" }); remember(key, null); };
  opts.signal.addEventListener("abort", cancel, { once: true });
  // (the chunks stop together: on the caller's abort, or when one can't be sent)
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const report = progressMeter(file.size, opts.onProgress);
  const lenOf = (n: number) => Math.min(chunkBytes, file.size - n * chunkBytes);
  const count = Math.ceil(file.size / chunkBytes);
  const queue = [...Array(count).keys()].filter((n) => !have.includes(n));
  let done = have.reduce((sum, n) => sum + lenOf(n), 0);
  const flying = new Map<number, number>();
  const sent = () => done + [...flying.values()].reduce((a, b) => a + b, 0);
  const send = async (n: number) => {
    const offset = n * chunkBytes;
    const chunk = file.slice(offset, offset + lenOf(n));
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await putChunk(`${api}/${id}?offset=${offset}`, chunk, stop.signal, (loaded) => {
          flying.set(n, loaded);
          report(sent());
        });
        if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(res.body.error ?? `HTTP ${res.status}`), { status: res.status, body: res.body });
        flying.delete(n);
        done += chunk.size;
        report(sent(), true);
        return;
      } catch (err) {
        flying.delete(n);
        const status = (err as { status?: number }).status;
        // (a refusal won't change by trying again: a gone session, a bad chunk)
        if (stop.signal.aborted || status === 404 || (status && status >= 400 && status < 500) || attempt >= 5) throw err;
        await sleep(1000 * 2 ** attempt, stop.signal);
      }
    }
  };
  try {
    report(done, true);
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) await send(n);
      }),
    ).catch((err) => {
      stop.abort();
      throw err;
    });
    const finished = await json<{ path: string }>(await fetch(`${api}/${id}`, { method: "POST", signal: opts.signal }));
    remember(key, null);
    return finished.path;
  } finally {
    opts.signal.removeEventListener("abort", cancel);
    opts.signal.removeEventListener("abort", onAbort);
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
