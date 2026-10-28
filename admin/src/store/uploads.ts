"use client";

import { Subject } from "subjecto";

import { uploadFile } from "@/components/files/upload-client";
import { BASE_PATH } from "@/lib/config";

/**
 * The Files page's uploads, kept outside React so they carry on when you switch views: the explorer starts them,
 * `<UploadDock>` in the root layout shows them on every other page. A full reload still stops them (the browser drops
 * the File objects); dropping the same file again then resumes where it stopped (upload-client.ts).
 */
export type Upload = {
  key: string;
  name: string;
  dir: string;
  size: number;
  sent: number;
  bytesPerSec: number | null;
  status: "uploading" | "done" | "error" | "cancelled";
  error?: string;
  abort: AbortController;
};

export const uploads = new Subject<Upload[]>([], { name: "fileUploads" });

/** The folder a batch of uploads went into, each time one finishes, so the explorer can reload it if it's showing it. */
export const uploadedInto = new Subject<{ dir: string; at: number } | null>(null, { name: "fileUploadsDone" });

const update = (key: string, patch: Partial<Upload>) =>
  uploads.next(uploads.getValue().map((x) => (x.key === key ? { ...x, ...patch } : x)));

export const isUploading = (u: Upload) => u.status === "uploading";

export function clearFinishedUploads() {
  uploads.next(uploads.getValue().filter(isUploading));
}

/**
 * Uploads `files` (paths relative to `dir`, a dropped folder's subfolders made first), one at a time; `project`: from a
 * project's Files tab, which the server keeps inside that project's folder.
 */
export async function startUploads(files: { file: File; rel: string }[], dir: string, project?: string) {
  // (a dropped folder's subfolders first: made as needed, "already exists" is fine)
  const folders = [...new Set(files.map((f) => f.rel.split("/").slice(0, -1).join("/")).filter(Boolean))].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const f of folders) {
    const parts = f.split("/");
    await fetch(`${BASE_PATH}/api/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "mkdir", dir: [dir, ...parts.slice(0, -1)].join("/"), name: parts[parts.length - 1], project }),
    }).catch(() => {});
  }
  for (const { file, rel } of files) {
    const parts = rel.split("/"), name = parts.pop()!, into = [dir, ...parts].join("/");
    const key = `${into}/${name}#${Date.now()}`, abort = new AbortController();
    uploads.next([...uploads.getValue(), { key, name: rel, dir: into, size: file.size, sent: 0, bytesPerSec: null, status: "uploading", abort }]);
    try {
      await uploadFile(file, into, name, { project, signal: abort.signal, onProgress: (p) => update(key, { sent: p.sent, bytesPerSec: p.bytesPerSec }) });
      update(key, { status: "done", sent: file.size });
    } catch (err) {
      update(key, abort.signal.aborted ? { status: "cancelled" } : { status: "error", error: (err as Error).message });
    }
  }
  uploadedInto.next({ dir, at: Date.now() });
}
