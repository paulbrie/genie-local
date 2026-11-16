import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";

import { descendants, parseProcStatus, type TreeProc } from "./process-tree";
import { readLatestProcesses, type ProcessInfo } from "./stats";

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

const ALLOWED_SIGNALS: readonly KillSignal[] = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
];

export function isKillSignal(v: unknown): v is KillSignal {
  return typeof v === "string" && (ALLOWED_SIGNALS as string[]).includes(v);
}

export type KillOutcome = {
  pid: number;
  ok: boolean;
  error?: string;
};

export type KillResult = {
  requested: number;
  outcomes: KillOutcome[];
};

/**
 * PIDs we must never signal, regardless of ownership:
 * - pid 1 (init/systemd)
 * - this Node process (the admin server) and its group leader, so a kill from
 *   the UI can't take down the dashboard itself.
 */
function protectedPids(): Set<number> {
  const self = process.pid;
  const guarded = new Set<number>([0, 1, self]);
  try {
    // Parent of the admin server (next dev / systemd) — killing it kills us too.
    if (typeof process.ppid === "number") guarded.add(process.ppid);
  } catch {
    /* ignore */
  }
  return guarded;
}

/** The box's user names by uid (/etc/passwd), read once. */
let usersByUid: Promise<Map<number, string>> | null = null;
function userNames(): Promise<Map<number, string>> {
  usersByUid ??= fs.readFile("/etc/passwd", "utf8").then(
    (text) => new Map(text.split("\n").map((l) => l.split(":")).filter((f) => f.length > 2).map((f) => [Number(f[2]), f[0]] as const)),
    () => new Map(),
  );
  return usersByUid;
}

/** What /proc says of process `pid`; null: it's gone (or can't be read). */
async function readProc(pid: number, users: Map<number, string>): Promise<TreeProc | null> {
  const s = parseProcStatus(await fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => ""));
  return s && { pid, ppid: s.ppid, user: users.get(s.uid) ?? String(s.uid), cpu: null, mem: s.mem, name: s.name, port: "" };
}

/** Every process now, from /proc. */
async function readAllProcs(): Promise<TreeProc[]> {
  const users = await userNames();
  const pids = (await fs.readdir("/proc")).filter((n) => /^\d+$/.test(n)).map(Number);
  return (await Promise.all(pids.map((pid) => readProc(pid, users)))).filter((p) => p !== null);
}

/**
 * Those above `procs` that aren't among them, up to init, from /proc: the stats daemon records only the busiest
 * processes, so a tree of those alone is in pieces (the Processes widget's tree). One gone meanwhile ends its line.
 */
export async function readAncestors(procs: readonly ProcessInfo[]): Promise<TreeProc[]> {
  const users = await userNames();
  const known = new Set(procs.map((p) => p.pid));
  const out: TreeProc[] = [];
  let next = procs.map((p) => p.ppid);
  while (next.length && out.length < 500) {
    const want = [...new Set(next)].filter((pid) => pid > 1 && !known.has(pid));
    for (const pid of want) known.add(pid);
    const got = (await Promise.all(want.map((pid) => readProc(pid, users)))).filter((p) => p !== null);
    out.push(...got);
    next = got.map((p) => p.ppid);
  }
  return out;
}

/**
 * Signal a process (optionally its whole spawn subtree). The admin runs as an
 * unprivileged user, so the kernel already refuses processes we don't own
 * (EPERM); we additionally guard pid 1 and the admin server itself. When
 * `tree` is set we kill children before parents so a supervisor can't respawn
 * a child after we've already reaped it. The tree is every process under it,
 * from /proc (the daemon's snapshot only has the busiest, and a child left out
 * of it would live on); the snapshot only if /proc can't be read.
 */
export async function killProcess(
  pid: number,
  opts: { signal?: KillSignal; tree?: boolean } = {},
): Promise<KillResult> {
  const signal = opts.signal ?? "SIGTERM";
  const guarded = protectedPids();

  let targets: number[] = [pid];
  if (opts.tree) {
    const all = await readAllProcs().catch(async () => (await readLatestProcesses())?.processes ?? []);
    targets = descendants(pid, all);
  }

  const outcomes: KillOutcome[] = [];
  for (const target of targets) {
    if (guarded.has(target)) {
      outcomes.push({
        pid: target,
        ok: false,
        error: "protected process (refused)",
      });
      continue;
    }
    try {
      process.kill(target, signal);
      outcomes.push({ pid: target, ok: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg =
        code === "EPERM"
          ? `not permitted (owned by another user; you run as ${os.userInfo().username})`
          : code === "ESRCH"
            ? "no such process (already gone)"
            : (err as Error).message;
      outcomes.push({ pid: target, ok: false, error: msg });
    }
  }

  return { requested: pid, outcomes };
}
