"use client";

import { confirmDialog } from "@/lib/ask";
import { BASE_PATH } from "@/lib/config";

/** What the explorer and its file windows share: the API, a listing's entry, and which files preview how. */
export type Entry = { name: string; path: string; type: "dir" | "file" | "symlink" | "other"; size: number; modified: string; secret: boolean };

export const API = `${BASE_PATH}/api/files`;
// (no SVG: it would run on the admin's origin; it previews as text)
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico)$/i, PDF = /\.pdf$/i;
export const within = (p: string, root: string) => root === "/" || p === root || p.startsWith(`${root}/`);
/** kernel pseudo-files (/proc, /sys): listed, never read */
export const pseudo = (p: string) => within(p, "/proc") || within(p, "/sys");
/** a file a window can show: a regular file, not a kernel one */
export const viewable = (e: Entry) => e.type === "file" && !pseudo(e.path);

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}
export const postTo = <T,>(body: object) => api<T>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** a file's contents, as an <img> / <iframe> source or a download (`scope`: "&project=<slug>" from a project's Files tab, else "") */
export const rawUrl = (scope: string, e: Entry, download = false) =>
  `${API}/raw?path=${encodeURIComponent(e.path)}${download ? `&download=1${e.secret ? "&confirm=1" : ""}` : ""}${scope}`;

/** downloads a file; a credential file only once confirmed (the download is logged) */
export async function downloadFile(scope: string, e: Entry) {
  if (e.secret && !(await confirmDialog(`${e.path} may hold passwords or keys. It downloads to this computer; the download is logged.`, { title: "Download a credential file?", confirmLabel: "Download" }))) return;
  const a = document.createElement("a");
  a.href = rawUrl(scope, e, true);
  a.click();
}
