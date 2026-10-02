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

/** One downsampled point (percentages 0–100; byte fields for tooltips). */
export type HistoryPoint = {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
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
  disk: number;
  mu: number;
  mt: number;
  du: number;
  dt: number;
};

/** Roughly this many points across the window — enough for a smooth sparkline. */
const TARGET_BUCKETS = 180;

type Acc = {
  n: number;
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
      a = { n: 0, cpu: 0, mem: 0, disk: 0, mu: 0, mt: 0, du: 0, dt: 0, t: 0 };
      buckets.set(key, a);
    }
    a.n++;
    a.cpu += p.cpu ?? 0;
    a.mem += p.mem ?? 0;
    a.disk += p.disk ?? 0;
    a.mu += p.mu ?? 0;
    a.mt += p.mt ?? 0;
    a.du += p.du ?? 0;
    a.dt += p.dt ?? 0;
    a.t += p.t;
  }

  const points: HistoryPoint[] = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, a]) => ({
      t: Math.round(a.t / a.n),
      cpu: a.cpu / a.n,
      mem: a.mem / a.n,
      disk: a.disk / a.n,
      memUsedBytes: a.mu / a.n,
      memTotalBytes: a.mt / a.n,
      diskUsedBytes: a.du / a.n,
      diskTotalBytes: a.dt / a.n,
    }));

  return { range, bucketMs, points };
}
