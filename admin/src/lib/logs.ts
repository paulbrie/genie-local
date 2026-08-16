import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { AGENT_RUNS_PREFIX, AGENT_RUNS_ROOT } from "@/lib/run-paths";

// Root directory scanned for log files. Defaults to /tmp; override with LOGS_ROOT.
export const LOGS_ROOT = process.env.LOGS_ROOT ?? "/tmp";

/**
 * Extra log roots mounted under a virtual prefix. Agent/pipeline runs persist
 * outside /tmp (so history survives reboots), yet still need to appear in the
 * Logs list + tail: we expose AGENT_RUNS_ROOT as `run-logs/…`. A caller-supplied
 * path starting with the prefix resolves against the extra root; everything else
 * resolves against LOGS_ROOT as before.
 */
const EXTRA_ROOTS: { prefix: string; dir: string }[] = [
  { prefix: AGENT_RUNS_PREFIX, dir: AGENT_RUNS_ROOT },
];

/** Map a relative log id to its backing root + the path within that root. */
function rootFor(rel: string): { base: string; sub: string; prefix: string } {
  for (const { prefix, dir } of EXTRA_ROOTS) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) {
      return { base: path.resolve(dir), sub: rel.slice(prefix.length + 1), prefix };
    }
  }
  return { base: path.resolve(LOGS_ROOT), sub: rel, prefix: "" };
}

// Files with these extensions are treated as logs.
const LOG_EXTENSIONS = new Set([".log", ".out", ".err", ".jsonl", ".txt"]);
// Directories never descended into while scanning.
const EXCLUDE_DIRS = new Set(["node_modules", ".git", ".cache", ".next"]);
const MAX_DEPTH = 4;

// Tail read sizing: default slice and hard cap (protects memory / response size).
export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export type LogFile = {
  /** Path relative to LOGS_ROOT (the stable id used by the tail endpoint). */
  path: string;
  size: number;
  mtimeMs: number;
};

export type LogTail = {
  path: string;
  size: number;
  mtimeMs: number;
  /** Bytes actually returned (from the end of the file). */
  returnedBytes: number;
  /** True when the file was larger than the requested window. */
  truncated: boolean;
  content: string;
};

function isLogName(name: string): boolean {
  return LOG_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Resolve a caller-supplied relative path to an absolute path inside its backing
 * root (LOGS_ROOT, or an EXTRA_ROOT when prefixed), rejecting traversal (`..`),
 * absolute paths, and non-log extensions.
 */
export function resolveLogPath(rel: string): string {
  const { base, sub } = rootFor(rel);
  const resolved = path.resolve(base, sub);
  const relCheck = path.relative(base, resolved);
  if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error("Path is outside the logs root");
  }
  if (!isLogName(resolved)) {
    throw new Error("Not a log file");
  }
  return resolved;
}

/** Recursively collect log files under `dir`, ids prefixed with `idPrefix`. */
async function collectLogs(
  dir: string,
  idPrefix: string,
  out: LogFile[],
): Promise<void> {
  const root = path.resolve(dir);

  async function walk(cur: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      // Skip symlinks entirely: prevents escaping the root via a linked dir/file.
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || EXCLUDE_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
      } else if (entry.isFile() && isLogName(entry.name)) {
        try {
          const st = await fs.stat(abs);
          const relPath = path.relative(root, abs);
          out.push({
            path: idPrefix ? `${idPrefix}/${relPath}` : relPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // vanished between readdir and stat — skip
        }
      }
    }
  }

  await walk(root, 0);
}

/** Recursively list log files under LOGS_ROOT + the extra roots, newest first. */
export async function listLogs(): Promise<LogFile[]> {
  const out: LogFile[] = [];
  await collectLogs(LOGS_ROOT, "", out);
  for (const { prefix, dir } of EXTRA_ROOTS) await collectLogs(dir, prefix, out);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Read the last `maxBytes` of a log file (validated, within LOGS_ROOT). */
export async function readLogTail(
  rel: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): Promise<LogTail | null> {
  const abs = resolveLogPath(rel);
  const window = Math.min(Math.max(1, maxBytes), MAX_TAIL_BYTES);

  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch {
    return null; // missing / unreadable
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    const readSize = Math.min(st.size, window);
    const start = st.size - readSize;
    const buf = Buffer.alloc(readSize);
    if (readSize > 0) await handle.read(buf, 0, readSize, start);
    let content = buf.toString("utf8");
    const truncated = start > 0;
    // Drop a leading partial line when we started mid-file.
    if (truncated) {
      const nl = content.indexOf("\n");
      if (nl !== -1) content = content.slice(nl + 1);
    }
    return {
      path: rel, // echo back the caller's (possibly prefixed) id
      size: st.size,
      mtimeMs: st.mtimeMs,
      returnedBytes: readSize,
      truncated,
      content,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
