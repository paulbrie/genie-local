import "server-only";

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type DiskDir, type DiskEntry, type DiskOverview, type DiskPart, otherPart, parseDf, parseDockerDf, parseDuTop, parseDuTree } from "@/lib/disk-overview-core";
import { resolveExisting } from "@/lib/files/guard";

const pexec = promisify(execFile);

/**
 * The folders the Disk widget measures, with their names: the projects, /tmp, the admin user's home (other homes are
 * Other), /usr and /var (what of it can be read: Docker's own folder can't, `docker system df` counts that).
 */
const FOLDERS: { path: string; label: string }[] = [
  { path: "/opt/project", label: "/opt/project" },
  { path: "/tmp", label: "/tmp" },
  { path: os.homedir(), label: `~${os.userInfo().username}` },
  { path: "/usr", label: "/usr" },
  { path: "/var", label: "/var" },
];
/** The filesystems df is asked about: the ones the folders are on. */
const DISK_PATHS = ["/opt/project", "/tmp"];
/** How long a measuring holds before the next listing measures again (in the background: a full one takes a minute). */
const FRESH_MS = 10 * 60_000;

// (kept on globalThis: the dev server reloads this module, and one measuring at a time is the point; named for the
// shape it holds, so a reload doesn't pick up an older one)
const g = globalThis as { __diskParts?: { last: { parts: DiskPart[]; at: number } | null; running: Promise<void> | null } };
const state = (g.__diskParts ??= { last: null, running: null });

/** Run a command and keep what it printed even when it exits non-zero (du does, on a folder it may not read). */
async function out(cmd: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await pexec(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

/** Each folder's size and largest entries (one du each, at low priority: a big tree takes half a minute), then Docker's. */
async function measure(): Promise<void> {
  const parts: DiskPart[] = [];
  for (const f of FOLDERS) {
    const r = parseDuTop(await out("nice", ["-n", "19", "du", "-axB1", "--max-depth=1", "--", f.path], 180_000), f.path);
    if (r) parts.push({ key: f.path, label: f.label, bytes: r.bytes, top: await markDirs(f.path, r.top) });
  }
  const docker = parseDockerDf(await out("docker", ["system", "df", "--format", "{{.Type}}\t{{.Size}}"], 20_000));
  if (docker) parts.push(docker);
  state.last = { parts, at: Date.now() };
}

/**
 * The Disk widget's figures: the filesystems now, the folders as last measured. A measuring older than FRESH_MS (or
 * `fresh`) starts a new one in the background, so this answers at once; `scanning` says one is under way.
 */
export async function diskOverview(fresh = false): Promise<DiskOverview> {
  const fs = parseDf(await out("df", ["-B1", "--output=target,size,used,avail", ...DISK_PATHS], 10_000));
  const stale = !state.last || fresh || Date.now() - state.last.at > FRESH_MS;
  if (stale && !state.running) state.running = measure().finally(() => (state.running = null));
  // (the rest of what's used: from the disk as it is now, against the parts as last measured)
  const parts = state.last ? [...state.last.parts, otherPart(fs[0]?.used ?? 0, state.last.parts)] : null;
  return { fs, parts, scannedAt: state.last?.at ?? null, scanning: !!state.running };
}

/** Each entry of `dir` marked a folder or not (to drill into), as lstat tells: a link isn't followed. */
async function markDirs<T extends DiskEntry>(dir: string, entries: T[]): Promise<T[]> {
  return Promise.all(entries.map(async (e) => ({ ...e, dir: e.dir ?? (await fsp.lstat(path.join(dir, e.name)).then((st) => st.isDirectory(), () => false)) })));
}

const DIR_FRESH_MS = 5 * 60_000;
const gd = globalThis as { __diskDirs?: Map<string, { at: number; p: Promise<DiskDir> }> };
const dirs = (gd.__diskDirs ??= new Map());

/**
 * A folder drilled into from the Disk widget's treemap: its entries and theirs (du two levels deep, at low priority),
 * each marked a folder or not. Anywhere the Files explorer may look (its roots, the path resolved); kept 5 minutes,
 * and one measuring at a time per folder (the others asking wait for it).
 */
export async function diskDir(p: string): Promise<DiskDir> {
  const { abs } = await resolveExisting(p);
  const hit = dirs.get(abs);
  if (hit && Date.now() - hit.at < DIR_FRESH_MS) return hit.p;
  const job = (async () => {
    const tree = parseDuTree(await out("nice", ["-n", "19", "du", "-axB1", "--max-depth=2", "--", abs], 180_000), abs);
    if (!tree) return { path: abs, bytes: 0, entries: [], measuredAt: Date.now() };
    const entries = await Promise.all(
      (await markDirs(abs, tree.entries)).map(async (e) => ({ ...e, top: e.dir ? await markDirs(path.join(abs, e.name), e.top) : [] })),
    );
    return { ...tree, entries, measuredAt: Date.now() };
  })();
  job.catch(() => dirs.delete(abs));
  dirs.set(abs, { at: Date.now(), p: job });
  // (no more than a few dozen folders kept)
  if (dirs.size > 60) dirs.delete(dirs.keys().next().value!);
  return job;
}
