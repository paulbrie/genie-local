import "server-only";

import { promises as fs } from "node:fs";

/**
 * Persistent CPU/MEM/DISK history, written by `scripts/stats-history.mjs` (a
 * per-minute cron sampler). Kept OUTSIDE the admin app dir so `next dev`'s file
 * watcher doesn't recompile on every append. Keep the path in sync with the
 * script's STATS_HISTORY_FILE default.
 */
const HISTORY_FILE =
  process.env.STATS_HISTORY_FILE ?? "/opt/project/.stats-history/history.jsonl";

export type HistoryRange = "1d" | "7d" | "30d";

/** Milliseconds covered by each selectable range. */
export const RANGE_MS: Record<HistoryRange, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function isHistoryRange(v: string): v is HistoryRange {
  return v === "1d" || v === "7d" || v === "30d";
}

/**
 * One downsampled point (percentages 0–100; byte fields for tooltips). Disk is
 * null where no sample in the bucket had it (history imported from sysstat,
 * which doesn't record disk usage): the chart leaves a gap, not a 0 %.
 */
export type HistoryPoint = {
  t: number;
  cpu: number;
  mem: number;
  disk: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
};

export type StatsHistory = {
  range: HistoryRange;
  bucketMs: number;
  points: HistoryPoint[];
};

/** Compact on-disk record shape (short keys — see the sampler). */
type RawPoint = {
  t: number;
  cpu: number;
  mem: number;
  disk?: number;
  mu: number;
  mt: number;
  du?: number;
  dt?: number;
  /** Each running project's memory (MB), and its agents' apart; absent before they were recorded. */
  pm?: Record<string, number>;
  pa?: Record<string, number>;
};

/** Roughly this many points across the window — enough for a smooth sparkline. */
const TARGET_BUCKETS = 180;

type Acc = {
  n: number;
  /** Samples that had disk figures (sysstat imports don't). */
  diskN: number;
  cpu: number;
  mem: number;
  disk: number;
  mu: number;
  mt: number;
  du: number;
  dt: number;
  t: number;
};

/**
 * Read the history file and downsample the requested range into ~180 evenly
 * spaced, time-averaged buckets. Empty buckets are omitted (the client draws a
 * continuous line through the points it gets). Returns an empty series when no
 * history exists yet.
 */
export async function readStatsHistory(
  range: HistoryRange,
  now: number = Date.now(),
): Promise<StatsHistory> {
  const spanMs = RANGE_MS[range];
  const start = now - spanMs;
  const bucketMs = Math.max(1, Math.floor(spanMs / TARGET_BUCKETS));

  let raw: string;
  try {
    raw = await fs.readFile(HISTORY_FILE, "utf8");
  } catch {
    return { range, bucketMs, points: [] };
  }

  const buckets = new Map<number, Acc>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let p: RawPoint;
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof p.t !== "number" || p.t < start || p.t > now) continue;
    const key = Math.floor((p.t - start) / bucketMs);
    let a = buckets.get(key);
    if (!a) {
      a = { n: 0, diskN: 0, cpu: 0, mem: 0, disk: 0, mu: 0, mt: 0, du: 0, dt: 0, t: 0 };
      buckets.set(key, a);
    }
    a.n++;
    a.cpu += p.cpu ?? 0;
    a.mem += p.mem ?? 0;
    a.mu += p.mu ?? 0;
    a.mt += p.mt ?? 0;
    if (typeof p.disk === "number") {
      a.diskN++;
      a.disk += p.disk;
      a.du += p.du ?? 0;
      a.dt += p.dt ?? 0;
    }
    a.t += p.t;
  }

  const points: HistoryPoint[] = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, a]) => ({
      t: Math.round(a.t / a.n),
      cpu: a.cpu / a.n,
      mem: a.mem / a.n,
      disk: a.diskN ? a.disk / a.diskN : null,
      memUsedBytes: a.mu / a.n,
      memTotalBytes: a.mt / a.n,
      diskUsedBytes: a.diskN ? a.du / a.diskN : null,
      diskTotalBytes: a.diskN ? a.dt / a.diskN : null,
    }));

  return { range, bucketMs, points };
}

/** One project's memory over time: its processes and containers, and its agents apart (bytes, bucket averages). */
export type ProjectMemoryPoint = { t: number; bytes: number; agentBytes: number };
export type ProjectMemoryHistory = { range: HistoryRange; bucketMs: number; points: ProjectMemoryPoint[] };

/**
 * A project's memory from the same history file, downsampled like the server's
 * figures. A sample from before projects were recorded is skipped; one where the
 * project wasn't running counts as 0.
 */
export async function readProjectMemoryHistory(slug: string, range: HistoryRange, now: number = Date.now()): Promise<ProjectMemoryHistory> {
  const spanMs = RANGE_MS[range];
  const start = now - spanMs;
  const bucketMs = Math.max(1, Math.floor(spanMs / TARGET_BUCKETS));
  let raw: string;
  try {
    raw = await fs.readFile(HISTORY_FILE, "utf8");
  } catch {
    return { range, bucketMs, points: [] };
  }
  const MB = 1024 * 1024;
  const buckets = new Map<number, { n: number; t: number; mb: number; agentMb: number }>();
  for (const line of raw.split("\n")) {
    // (lines from before projects were recorded: no need to parse them)
    if (!line.includes('"pm"')) continue;
    let p: RawPoint;
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof p.t !== "number" || p.t < start || p.t > now || !p.pm) continue;
    const key = Math.floor((p.t - start) / bucketMs);
    const a = buckets.get(key) ?? { n: 0, t: 0, mb: 0, agentMb: 0 };
    a.n++;
    a.t += p.t;
    a.mb += p.pm[slug] ?? 0;
    a.agentMb += p.pa?.[slug] ?? 0;
    buckets.set(key, a);
  }
  const points = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, a]) => ({ t: Math.round(a.t / a.n), bytes: (a.mb / a.n) * MB, agentBytes: (a.agentMb / a.n) * MB }));
  return { range, bucketMs, points };
}
