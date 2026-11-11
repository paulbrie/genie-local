import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type DiskOverview, type DiskPath, parseDf, parseDuTop } from "@/lib/disk-overview-core";

const pexec = promisify(execFile);

/** The folders the Disk widget measures. */
export const DISK_PATHS = ["/opt/project", "/tmp"];
/** How long a measuring holds before the next listing measures again (in the background). */
const FRESH_MS = 5 * 60_000;

// (kept on globalThis: the dev server reloads this module, and one measuring at a time is the point)
const g = globalThis as { __diskOverview?: { last: { paths: DiskPath[]; at: number } | null; running: Promise<void> | null } };
const state = (g.__diskOverview ??= { last: null, running: null });

/** Run a command and keep what it printed even when it exits non-zero (du does, on a folder it may not read). */
async function out(cmd: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await pexec(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

/** Each folder's size and largest entries: one du per folder, at low priority (a big tree takes half a minute). */
async function measure(): Promise<void> {
  const paths: DiskPath[] = [];
  for (const p of DISK_PATHS) {
    const r = parseDuTop(await out("nice", ["-n", "19", "du", "-axB1", "--max-depth=1", "--", p], 180_000), p);
    if (r) paths.push(r);
  }
  state.last = { paths, at: Date.now() };
}

/**
 * The Disk widget's figures: the filesystems now, the folders as last measured. A measuring older than FRESH_MS (or
 * `fresh`) starts a new one in the background, so this answers at once; `scanning` says one is under way.
 */
export async function diskOverview(fresh = false): Promise<DiskOverview> {
  const fs = parseDf(await out("df", ["-B1", "--output=target,size,used,avail", ...DISK_PATHS], 10_000));
  const stale = !state.last || fresh || Date.now() - state.last.at > FRESH_MS;
  if (stale && !state.running) state.running = measure().finally(() => (state.running = null));
  return { fs, paths: state.last?.paths ?? null, scannedAt: state.last?.at ?? null, scanning: !!state.running };
}
