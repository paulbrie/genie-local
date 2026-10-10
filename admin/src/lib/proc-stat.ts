/**
 * Per-core CPU use from /proc/stat: each `cpuN` line holds the jiffies a core
 * has spent in each state since boot, so a core's busy % is the busy share of
 * the time between two readings. Pure (parsing and the difference); the
 * reading itself is in lib/stats.ts.
 */

/** One core's counters: busy (everything but idle and iowait) and total jiffies. */
export type CoreTimes = { busy: number; total: number };

/** The per-core counters of /proc/stat's text, in core order (cpu0, cpu1, …); the "cpu" total line is skipped. */
export function parseProcStat(text: string): CoreTimes[] {
  const cores: { n: number; t: CoreTimes }[] = [];
  for (const line of text.split("\n")) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    // user nice system idle iowait irq softirq steal [guest guest_nice]: guest time is already in user/nice.
    const v = m[2].split(/\s+/).slice(0, 8).map(Number);
    if (v.length < 4 || v.some((x) => !Number.isFinite(x))) continue;
    const total = v.reduce((a, b) => a + b, 0);
    const idle = v[3] + (v[4] ?? 0);
    cores.push({ n: Number(m[1]), t: { busy: total - idle, total } });
  }
  return cores.sort((a, b) => a.n - b.n).map((c) => c.t);
}

/**
 * Each core's busy % (0–100, one decimal) between two readings; null when they
 * can't be compared (a different number of cores, e.g. a core went offline).
 */
export function coreBusyPercent(prev: CoreTimes[], next: CoreTimes[]): number[] | null {
  if (!prev.length || prev.length !== next.length) return null;
  return next.map((c, i) => {
    const dt = c.total - prev[i].total;
    if (dt <= 0) return 0;
    const pct = (100 * (c.busy - prev[i].busy)) / dt;
    return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
  });
}
