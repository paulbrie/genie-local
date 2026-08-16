import "server-only";

import os from "node:os";

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

/**
 * Walk the ppid map to collect a process and all of its descendants.
 * Cyclic/self-parent references are guarded by a visited set.
 */
function descendantsOf(root: number, procs: ProcessInfo[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const p of procs) {
    const list = childrenByParent.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByParent.set(p.ppid, [p.pid]);
  }
  const collected = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (collected.has(pid)) continue;
    collected.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      if (!collected.has(child)) stack.push(child);
    }
  }
  return [...collected];
}

/**
 * Signal a process (optionally its whole spawn subtree). The admin runs as an
 * unprivileged user, so the kernel already refuses processes we don't own
 * (EPERM); we additionally guard pid 1 and the admin server itself. When
 * `tree` is set we kill children before parents so a supervisor can't respawn
 * a child after we've already reaped it.
 */
export async function killProcess(
  pid: number,
  opts: { signal?: KillSignal; tree?: boolean } = {},
): Promise<KillResult> {
  const signal = opts.signal ?? "SIGTERM";
  const guarded = protectedPids();

  let targets: number[] = [pid];
  if (opts.tree) {
    const snapshot = await readLatestProcesses();
    if (snapshot) {
      const all = descendantsOf(pid, snapshot.processes);
      // Deepest-first: sort so children (which appear later via BFS/DFS order)
      // are signalled before their parents. We approximate by killing the root
      // last.
      targets = all.filter((p) => p !== pid);
      targets.push(pid);
    }
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
