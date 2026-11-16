// Pure (tested): the processes as a tree. The stats daemon records only the busiest processes, so the ones above them
// are read from /proc (processes.ts) to join them up; this reads what /proc says of one, lays the busiest out as a
// forest (the Processes widget's tree), and finds everything under a process (Kill tree).

/** A process in a tree: the daemon's figures, or what /proc says of one it didn't record (no CPU, no port). */
export type TreeProc = { pid: number; ppid: number; user: string; cpu: number | null; mem: number; name: string; port: string };

/** A row of the forest, depth-first: how deep, whether it's one of the busiest asked for, how many children it has here. */
export type TreeRow = TreeProc & { depth: number; busy: boolean; kids: number };

/** /proc/<pid>/status: its name, parent, real uid and resident memory in MB (a kernel thread's none). Null: not one. */
export function parseProcStatus(text: string): { name: string; ppid: number; uid: number; mem: number } | null {
  const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1];
  const name = field("Name");
  const ppid = Number(field("PPid"));
  const uid = Number(field("Uid")?.split(/\s+/)[0]);
  if (name === undefined || !Number.isInteger(ppid) || !Number.isInteger(uid)) return null;
  const kb = Number(/^VmRSS:\s*(\d+)\s*kB/m.exec(text)?.[1] ?? 0);
  return { name, ppid, uid, mem: Math.round((kb / 1024) * 10) / 10 };
}

/**
 * The busiest processes (`busy`, busiest first) joined up by those above them (`others`: the rest the daemon recorded,
 * and what /proc said of the ones it didn't), laid out depth-first. Everything is under init, so init's children are
 * the roots (init itself, if it's among the busiest, one of them, alone). Only what leads to a busy one is in it, and
 * siblings go in the order of the busiest under them.
 */
export function processForest(busy: readonly TreeProc[], others: readonly TreeProc[]): TreeRow[] {
  const byPid = new Map<number, TreeProc>();
  for (const p of others) byPid.set(p.pid, p);
  for (const p of busy) byPid.set(p.pid, p);
  const isBusy = new Set(busy.map((p) => p.pid));
  // (each one in it: the rank of the busiest under it, itself included)
  const rank = new Map<number, number>();
  const kids = new Map<number, number[]>();
  const roots: number[] = [];
  const joined = new Set<number>();
  busy.forEach((p, i) => {
    // up from it, until one a busier one joined up already, or a root (a parent met again on the way, a pid reused,
    // makes one too)
    const seen = new Set<number>();
    let q: TreeProc | undefined = p;
    while (q) {
      seen.add(q.pid);
      if (!rank.has(q.pid)) rank.set(q.pid, i);
      if (joined.has(q.pid)) break;
      joined.add(q.pid);
      const up = q.ppid > 1 && byPid.has(q.ppid) && !seen.has(q.ppid) ? q.ppid : null;
      if (up === null) {
        roots.push(q.pid);
        break;
      }
      (kids.get(up) ?? kids.set(up, []).get(up)!).push(q.pid);
      q = byPid.get(up);
    }
  });
  const order = (pids: number[]) => pids.sort((a, b) => rank.get(a)! - rank.get(b)! || a - b);
  const rows: TreeRow[] = [];
  const walk = (pid: number, depth: number) => {
    const under = order(kids.get(pid) ?? []);
    rows.push({ ...byPid.get(pid)!, depth, busy: isBusy.has(pid), kids: under.length });
    for (const c of under) walk(c, depth + 1);
  };
  for (const r of order(roots)) walk(r, 0);
  return rows;
}

/** Process `root` and everything under it (of `procs`), the deepest first and `root` last: the order to signal them in. */
export function descendants(root: number, procs: readonly { pid: number; ppid: number }[]): number[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) if (p.pid !== p.ppid) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p.pid);
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const c of kids.get(pid) ?? []) walk(c);
    out.push(pid);
  };
  walk(root);
  return out;
}
