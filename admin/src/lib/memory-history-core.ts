// Pure, dependency-free (tested): the Memory widget's history (stats-history.ts reads the file).

/** One moment, a bucket's averages: what's used on the server, each project's memory, and its Claude agents'. */
export type MemoryMoment = { t: number; used: number; projects: Record<string, number>; agents: Record<string, number> };
export type MemoryDistribution = { bucketMs: number; totalBytes: number; points: MemoryMoment[] };

const MB = 1024 * 1024;

/**
 * The history's per-minute lines (`mu`/`mt`: used / total bytes, `pm`/`pa`: projects' and agents' MB by slug) over
 * `spanMs` before `now`, averaged in `buckets` buckets: each project's memory, its agents', and the server's in use.
 * Lines from before projects were recorded (no `pm`) are left out, so every moment has them all.
 */
export function memoryDistribution(raw: string, spanMs: number, now: number, buckets = 180): MemoryDistribution {
  const start = now - spanMs;
  const bucketMs = Math.max(1, Math.floor(spanMs / buckets));
  type Acc = { n: number; t: number; used: number; pm: Record<string, number>; pa: Record<string, number> };
  const acc = new Map<number, Acc>();
  let totalBytes = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes('"pm"')) continue;
    let p: { t?: unknown; mu?: unknown; mt?: unknown; pm?: Record<string, number>; pa?: Record<string, number> };
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof p.t !== "number" || p.t < start || p.t > now || !p.pm || typeof p.mu !== "number") continue;
    if (typeof p.mt === "number") totalBytes = p.mt;
    const key = Math.floor((p.t - start) / bucketMs);
    const a = acc.get(key) ?? { n: 0, t: 0, used: 0, pm: {}, pa: {} };
    a.n++;
    a.t += p.t;
    a.used += p.mu;
    for (const [slug, mb] of Object.entries(p.pm)) a.pm[slug] = (a.pm[slug] ?? 0) + mb;
    for (const [slug, mb] of Object.entries(p.pa ?? {})) a.pa[slug] = (a.pa[slug] ?? 0) + mb;
    acc.set(key, a);
  }
  const avg = (m: Record<string, number>, n: number) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (v / n) * MB]));
  const points = [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, a]) => ({ t: Math.round(a.t / a.n), used: a.used / a.n, projects: avg(a.pm, a.n), agents: avg(a.pa, a.n) }));
  return { bucketMs, totalBytes, points };
}

/** Each project over the period: its average and its peak (its own memory and its agents' together), the biggest first. */
export function projectTotals(points: readonly MemoryMoment[]): { slug: string; avg: number; peak: number; agentsAvg: number }[] {
  const by = new Map<string, { sum: number; peak: number; agents: number }>();
  for (const p of points) {
    for (const slug of new Set([...Object.keys(p.projects), ...Object.keys(p.agents)])) {
      const own = p.projects[slug] ?? 0;
      const ag = p.agents[slug] ?? 0;
      const cur = by.get(slug) ?? { sum: 0, peak: 0, agents: 0 };
      cur.sum += own;
      cur.agents += ag;
      cur.peak = Math.max(cur.peak, own + ag);
      by.set(slug, cur);
    }
  }
  const n = Math.max(1, points.length);
  return [...by.entries()]
    .map(([slug, v]) => ({ slug, avg: v.sum / n, agentsAvg: v.agents / n, peak: v.peak }))
    .filter((x) => x.avg + x.agentsAvg > 0)
    .sort((a, b) => b.avg + b.agentsAvg - (a.avg + a.agentsAvg));
}
