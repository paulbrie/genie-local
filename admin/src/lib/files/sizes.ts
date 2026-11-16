// How much room each folder in a folder takes (the explorer's Size column, T243): du one level deep, at low priority,
// on disk as the Disk widget counts it. A folder on another filesystem (/proc, /dev, a mount) isn't measured. No
// "server-only" import, as for the rest of lib/files: its tests run under node.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseDuTop } from "@/lib/disk-overview-core";

const pexec = promisify(execFile);

export interface FolderSizes {
  path: string;
  /** the folder's own total; null: du said nothing of it (it ran out of time) */
  bytes: number | null;
  /** each folder in it, by name */
  sizes: Record<string, number>;
  measuredAt: number;
}

/** How long a measuring holds: a big tree takes du half a minute. */
const FRESH_MS = 5 * 60_000;

// (kept on globalThis: the dev server reloads this module, and one measuring at a time per folder is the point)
const g = globalThis as { __folderSizes?: Map<string, { at: number; running: boolean; p: Promise<FolderSizes> }> };
const kept = (g.__folderSizes ??= new Map());

async function measure(abs: string): Promise<FolderSizes> {
  let stdout = "";
  try {
    stdout = (await pexec("nice", ["-n", "19", "du", "-xB1", "--max-depth=1", "--", abs], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (e) {
    // (du exits non-zero on a folder it may not read inside: what it printed still holds)
    stdout = (e as { stdout?: string }).stdout ?? "";
  }
  const r = parseDuTop(stdout, abs, Infinity);
  return { path: abs, bytes: r?.bytes ?? null, sizes: Object.fromEntries((r?.top ?? []).map((e) => [e.name, e.bytes])), measuredAt: Date.now() };
}

/**
 * The size of each folder in `abs` (a folder, already resolved within the request's roots). Kept 5 minutes; `fresh`
 * (after a change there, or Refresh) measures again, unless a measuring of it is under way: the others asking wait for it.
 */
export function folderSizes(abs: string, fresh = false): Promise<FolderSizes> {
  const hit = kept.get(abs);
  if (hit && (hit.running || (!fresh && Date.now() - hit.at < FRESH_MS))) return hit.p;
  const job = { at: Date.now(), running: true, p: measure(abs) };
  job.p.then(
    () => (job.running = false),
    () => kept.get(abs) === job && kept.delete(abs),
  );
  kept.delete(abs);
  kept.set(abs, job);
  // (no more than a hundred folders kept)
  if (kept.size > 100) kept.delete(kept.keys().next().value!);
  return job.p;
}
