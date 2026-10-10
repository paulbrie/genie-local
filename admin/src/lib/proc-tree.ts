/**
 * A process tree's CPU and memory from /proc (pure: parsing and the sums; the
 * reading is the caller's). CPU % is the tree's share of one core between two
 * readings, from each process's utime + stime: a process started since the
 * previous reading counts all its time, one that ended drops out.
 */

/** What /proc/<pid>/stat gives about one process (times in clock ticks since boot). */
export type ProcStat = { pid: number; ppid: number; ticks: number; startTicks: number; rssPages: number };

/** /proc/<pid>/stat's line; robust to spaces and parentheses in the command name. Null if unreadable. */
export function parseProcPidStat(pid: number, text: string): ProcStat | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  // After "comm)": state(3) ppid(4) … utime(14) stime(15) … starttime(22) vsize(23) rss(24); index = field − 3.
  const f = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(f[1]), utime = Number(f[11]), stime = Number(f[12]), start = Number(f[19]), rss = Number(f[21]);
  if (![ppid, utime, stime, start, rss].every(Number.isFinite)) return null;
  return { pid, ppid, ticks: utime + stime, startTicks: start, rssPages: rss };
}

/** `root`'s descendants (not `root` itself), from every process's parent. */
export function descendants(procs: Iterable<ProcStat>, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const stack = [...(kids.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (out.includes(pid)) continue; // (a pid reused mid-read can't loop us)
    out.push(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return out.sort((a, b) => a - b);
}

/** A reading to compare the next one with: when (seconds since boot) and each process's ticks. */
export type TickReading = { uptime: number; ticks: Map<number, number> };

/**
 * The tree's CPU % (100 = one core) between `prev` and now, for the processes
 * in `pids`; null without a previous reading or with too little time between.
 */
export function treeCpuPercent(pids: number[], now: Map<number, ProcStat>, uptime: number, prev: TickReading | null, clkTck = 100): number | null {
  if (!prev) return null;
  const dt = uptime - prev.uptime;
  if (dt < 0.5) return null;
  let ticks = 0;
  for (const pid of pids) {
    const p = now.get(pid);
    if (!p) continue;
    const before = prev.ticks.get(pid);
    // Not seen before: started since (all its time is new), or a reused pid (skip).
    if (before === undefined) {
      if (p.startTicks / clkTck >= prev.uptime) ticks += p.ticks;
    } else if (p.ticks >= before) ticks += p.ticks - before;
  }
  return Math.round(((ticks / clkTck / dt) * 100) * 10) / 10;
}

/** The tree's resident memory in MB. */
export function treeMemMB(pids: number[], now: Map<number, ProcStat>, pageSize = 4096): number {
  let pages = 0;
  for (const pid of pids) pages += now.get(pid)?.rssPages ?? 0;
  return Math.round((pages * pageSize) / (1024 * 1024));
}
