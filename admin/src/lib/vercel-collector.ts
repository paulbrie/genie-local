import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { vercelIssues } from "@/db/schema";
import { addTask } from "@/lib/data";
import { call, vercelBuildLogs, vercelLinks, vercelRuntimeStream } from "@/lib/vercel";
import { buildProblemFingerprint, problemOf, type Problem, type RuntimeLine } from "@/lib/vercel-issues-core";

// Production problems on Vercel, for each project's Vercel tab. Vercel's API serves runtime logs only live, so this
// listens all the time: one feed per linked project, to its current production deployment (switching when a new
// one goes live, reconnecting when a feed ends), keeping only errors, warnings and 5xx responses, grouped by
// fingerprint (vercel-issues-core.ts) into vercel_issues. Failed production builds become issues too. It runs in the
// live admin only (instrumentation.ts): the dev instance shares the database and would count everything twice.

const TICK_MS = 60_000;
const FLUSH_MS = 5000;
const RECENT_KEPT = 5;
const PATHS_KEPT = 10;

type Watch = {
  slug: string;
  deploymentId: string;
  ctl: AbortController;
  since: number;
  lastLineAt: number | null;
  lines: number;
  problems: number;
  error: string | null;
};
type Pending = { projectId: number; deploymentId: string; p: Problem; count: number; at: number; recent: unknown[]; paths: Set<string> };

type Collector = { watches: Map<number, Watch>; pending: Map<string, Pending>; started: number; lastTick: number | null; tickError: string | null };
const g = globalThis as unknown as { __vercelCollector?: Collector };

/** Start listening (once per process). */
export function startVercelCollector(): void {
  if (g.__vercelCollector) return;
  const c: Collector = { watches: new Map(), pending: new Map(), started: Date.now(), lastTick: null, tickError: null };
  g.__vercelCollector = c;
  void tick(c);
  setInterval(() => void tick(c), TICK_MS).unref();
  setInterval(() => void flush(c), FLUSH_MS).unref();
  console.log("[vercel-collector] started");
}

/** What the Vercel tab says about the listening, for one project (null: not running in this process). */
export function collectorStatus(projectId: number) {
  const c = g.__vercelCollector;
  if (!c) return null;
  const w = c.watches.get(projectId);
  return {
    running: true,
    watching: w ? { deploymentId: w.deploymentId, since: w.since, lastLineAt: w.lastLineAt, lines: w.lines, problems: w.problems, error: w.error } : null,
    lastTick: c.lastTick,
    error: c.tickError,
  };
}

async function tick(c: Collector) {
  try {
    const links = await vercelLinks();
    const seen = new Set<number>();
    for (const link of links) {
      seen.add(link.projectId);
      try {
        const r = await call<{ deployments: { uid: string; readyState?: string; state?: string; created: number; meta?: Record<string, string | undefined> }[] }>(
          link.token,
          "/v6/deployments",
          link.teamId,
          { projectId: link.vercelProjectId, target: "production", limit: 10 },
        );
        const live = r.deployments.find((d) => (d.readyState ?? d.state) === "READY");
        await recordFailedBuilds(link.projectId, link.slug, r.deployments);
        const w = c.watches.get(link.projectId);
        if (!live) continue;
        if (w && w.deploymentId === live.uid && !w.ctl.signal.aborted) continue;
        w?.ctl.abort();
        startWatch(c, link.projectId, link.slug, live.uid);
      } catch (e) {
        const w = c.watches.get(link.projectId);
        if (w) w.error = (e as Error).message;
      }
    }
    for (const [pid, w] of c.watches) {
      if (!seen.has(pid)) {
        w.ctl.abort();
        c.watches.delete(pid);
      }
    }
    c.lastTick = Date.now();
    c.tickError = null;
  } catch (e) {
    c.tickError = (e as Error).message;
  }
}

function startWatch(c: Collector, projectId: number, slug: string, deploymentId: string) {
  const w: Watch = { slug, deploymentId, ctl: new AbortController(), since: Date.now(), lastLineAt: null, lines: 0, problems: 0, error: null };
  c.watches.set(projectId, w);
  void (async () => {
    while (!w.ctl.signal.aborted) {
      try {
        const stream = await vercelRuntimeStream(slug, deploymentId, w.ctl.signal, 30 * 60_000);
        w.error = null;
        const reader = stream.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!raw.trim()) continue;
            w.lines++;
            w.lastLineAt = Date.now();
            let line: RuntimeLine;
            try {
              line = JSON.parse(raw) as RuntimeLine;
            } catch {
              continue;
            }
            const p = problemOf(line);
            if (!p) continue;
            w.problems++;
            queue(c, projectId, deploymentId, p, line.at ?? Date.now());
          }
        }
      } catch (e) {
        if (w.ctl.signal.aborted) break;
        w.error = (e as Error).message;
        await sleep(60_000, w.ctl.signal);
        continue;
      }
      // (the feed ended by itself, or after its 30 minutes: listen again)
      await sleep(3000, w.ctl.signal);
    }
  })();
}

function queue(c: Collector, projectId: number, deploymentId: string, p: Problem, at: number) {
  const key = `${projectId}|${p.fingerprint}`;
  const cur = c.pending.get(key) ?? { projectId, deploymentId, p, count: 0, at, recent: [], paths: new Set<string>() };
  cur.count++;
  cur.p = p;
  cur.at = Math.max(cur.at, at);
  cur.deploymentId = deploymentId;
  cur.recent = [{ at, path: p.path, method: p.method, status: p.status, message: p.message.slice(0, 1000), deployment: deploymentId }, ...cur.recent].slice(0, RECENT_KEPT);
  if (p.path) cur.paths.add(p.path);
  c.pending.set(key, cur);
}

async function flush(c: Collector) {
  if (!c.pending.size) return;
  const batch = [...c.pending.values()];
  c.pending.clear();
  for (const b of batch) {
    await upsert({
      projectId: b.projectId,
      fingerprint: b.p.fingerprint,
      kind: "runtime",
      level: b.p.level,
      title: b.p.title,
      sample: b.p.message,
      recent: b.recent,
      paths: [...b.paths],
      count: b.count,
      at: new Date(b.at),
      deploymentId: b.deploymentId,
    }).catch((e) => console.error("[vercel-collector] saving an issue:", (e as Error).message));
  }
}

/** One problem seen `count` more times: a new issue, or the existing one counted (and back if it was dismissed). */
async function upsert(i: {
  projectId: number; fingerprint: string; kind: string; level: string; title: string; sample: string;
  recent: unknown[]; paths: string[]; count: number; at: Date; deploymentId: string;
}) {
  await db.execute(sql`
    insert into vercel_issues (project_id, fingerprint, kind, level, title, sample, recent, paths, count, first_seen, last_seen, last_deployment_id)
    values (${i.projectId}, ${i.fingerprint}, ${i.kind}, ${i.level}, ${i.title}, ${i.sample}, ${JSON.stringify(i.recent)}::jsonb, ${JSON.stringify(i.paths)}::jsonb, ${i.count}, ${i.at}, ${i.at}, ${i.deploymentId})
    on conflict (project_id, fingerprint) do update set
      count = vercel_issues.count + excluded.count,
      title = excluded.title,
      sample = excluded.sample,
      last_seen = greatest(vercel_issues.last_seen, excluded.last_seen),
      last_deployment_id = excluded.last_deployment_id,
      dismissed_at = null,
      recent = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(excluded.recent || vercel_issues.recent) e limit ${RECENT_KEPT}) s),
      paths = (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from (select p from jsonb_array_elements_text(vercel_issues.paths || excluded.paths) p limit ${PATHS_KEPT}) s)
  `);
}

/** Failed production builds among the latest: one issue each, with the end of its build log. */
async function recordFailedBuilds(
  projectId: number,
  slug: string,
  deployments: { uid: string; readyState?: string; state?: string; created: number; meta?: Record<string, string | undefined> }[],
) {
  for (const d of deployments) {
    if ((d.readyState ?? d.state) !== "ERROR") continue;
    const fingerprint = buildProblemFingerprint(d.uid);
    const [exists] = await db.select({ id: vercelIssues.id }).from(vercelIssues).where(and(eq(vercelIssues.projectId, projectId), eq(vercelIssues.fingerprint, fingerprint)));
    if (exists) continue;
    const log = await vercelBuildLogs(slug, d.uid).catch(() => []);
    // (the first error messages say what went wrong, the end where it stopped; stack frames and repeats say little)
    const meaningful = log.map((l) => ({ ...l, text: l.text.replace(/\s+$/, "") })).filter((l) => l.text && !/^\s*at\s/.test(l.text));
    const seenText = new Set<string>();
    const errors = meaningful.filter((l) => {
      if (!(l.type === "stderr" || /error|failed|cannot|can't|exception/i.test(l.text)) || seenText.has(l.text)) return false;
      seenText.add(l.text);
      return true;
    });
    const tail = meaningful.slice(-12).filter((l) => !seenText.has(l.text));
    const sample = [...errors.slice(0, 25).map((l) => l.text), ...(tail.length ? ["…", ...tail.map((l) => l.text)] : [])].join("\n").slice(0, 6000);
    const commit = (d.meta?.githubCommitMessage ?? "").split("\n")[0];
    const title = `Production build failed${commit ? `: ${commit}` : ""}`.slice(0, 200);
    await db
      .insert(vercelIssues)
      .values({
        projectId, fingerprint, kind: "build", level: "error", title, sample, count: 1,
        recent: [{ at: d.created, deployment: d.uid, commit: d.meta?.githubCommitSha?.slice(0, 7) ?? null, branch: d.meta?.githubCommitRef ?? null }],
        paths: [], firstSeen: new Date(d.created), lastSeen: new Date(d.created), lastDeploymentId: d.uid,
      })
      .onConflictDoNothing();
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

// ---------------------------------------------------------------- what the Vercel tab does with them

export async function listIssues(projectId: number, withDismissed: boolean) {
  return db
    .select()
    .from(vercelIssues)
    .where(withDismissed ? eq(vercelIssues.projectId, projectId) : and(eq(vercelIssues.projectId, projectId), isNull(vercelIssues.dismissedAt)))
    .orderBy(desc(vercelIssues.lastSeen))
    .limit(200);
}

export async function dismissIssue(projectId: number, id: number, dismissed: boolean) {
  await db.update(vercelIssues).set({ dismissedAt: dismissed ? new Date() : null }).where(and(eq(vercelIssues.projectId, projectId), eq(vercelIssues.id, id)));
}

/** A ticket in the project's Tasks from an issue, with what's known about it. Answers its id (the existing one if made). */
export async function ticketFromIssue(projectId: number, slug: string, id: number, vercelProjectName: string | null): Promise<number> {
  const [i] = await db.select().from(vercelIssues).where(and(eq(vercelIssues.projectId, projectId), eq(vercelIssues.id, id)));
  if (!i) throw new Error("no such issue");
  if (i.taskId) return i.taskId;
  const recent = (i.recent as { at?: number; path?: string | null; method?: string | null; status?: number | null; message?: string; deployment?: string; commit?: string | null; branch?: string | null }[]) ?? [];
  const paths = (i.paths as string[]) ?? [];
  const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    i.kind === "build"
      ? `A production build of ${vercelProjectName ?? slug} failed on Vercel.`
      : `Seen in production on Vercel (${vercelProjectName ?? slug}): ${i.count} time${i.count === 1 ? "" : "s"}, first ${when(i.firstSeen)}, last ${when(i.lastSeen)}.`,
    "",
    paths.length ? `Pages: ${paths.map((p) => `\`${p}\``).join(", ")}` : "",
    i.lastDeploymentId ? `Deployment: ${i.lastDeploymentId}` : "",
    "",
    i.kind === "build" ? "End of the build log:" : "Message:",
    "```",
    i.sample.slice(0, 6000),
    "```",
  ];
  if (i.kind === "runtime" && recent.length > 1) {
    lines.push("", "Recent occurrences:");
    for (const r of recent) lines.push(`- ${r.at ? when(new Date(r.at)) : ""} ${r.method ?? ""} ${r.path ?? ""} ${r.status ?? ""}`.replace(/\s+/g, " ").trim());
  }
  lines.push("", `(From Spiridus's Vercel tab, issue #${i.id}.)`);
  const title = `${i.level === "warning" ? "Production warning" : i.kind === "build" ? "Build" : "Production error"}: ${i.title}`.slice(0, 200);
  const taskId = await addTask(projectId, title.replace(/^Build: Production build failed/, "Production build failed"), lines.filter((l, k, a) => l !== "" || a[k - 1] !== "").join("\n"));
  await db.update(vercelIssues).set({ taskId }).where(eq(vercelIssues.id, i.id));
  return taskId;
}
