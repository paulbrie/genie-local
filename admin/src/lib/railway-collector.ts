import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { railwayIssues } from "@/db/schema";
import { addTask } from "@/lib/data";
import { deployRuntimeLine, httpRuntimeLine, stateOf } from "@/lib/railway-core";
import { buildLogsOf, deployLogsOf, httpLogsOf, railwayLinks, railwayServicesOf, RailwayApiError, setCollectedUntil, type TokenKind } from "@/lib/railway-project";
import { buildProblemFingerprint, problemOf, type Problem } from "@/lib/vercel-issues-core";

// Production problems on Railway, for each project's Railway tab, as the Vercel collector's for Vercel. Railway keeps
// its logs (3 days on its free plan, 7 on Hobby, 30 on Pro), so this reads them every 5 minutes from where it stopped
// (project_railway.collected_until, kept, so a restart misses nothing; a new link looks back a day): each running
// service's error and warning lines and its 5xx responses, grouped by fingerprint (vercel-issues-core.ts) into
// railway_issues; a failed build or a crashed deployment is an issue of its own. Few calls (one for the services, two
// a running service), as Railway allows 100 an hour on its free plan; told to slow down, it waits 15 minutes. It runs
// in the live admin only (instrumentation.ts): the dev instance shares the database and would count everything twice.

const TICK_MS = 5 * 60_000;
const LOOKBACK_MS = 24 * 3600_000;
// (Railway's logs land a little late: read up to a minute ago)
const LAG_MS = 60_000;
const LIMIT = 500;
const PAUSE_MS = 15 * 60_000;
const RECENT_KEPT = 5;
const PATHS_KEPT = 10;

type Seen = { lastRun: number | null; lines: number; problems: number; services: number; error: string | null };
type Collector = { started: number; lastTick: number | null; tickError: string | null; pausedUntil: number; seen: Map<number, Seen> };
const g = globalThis as unknown as { __railwayCollector?: Collector };

/** Start reading (once per process). */
export function startRailwayCollector(): void {
  if (g.__railwayCollector) return;
  const c: Collector = { started: Date.now(), lastTick: null, tickError: null, pausedUntil: 0, seen: new Map() };
  g.__railwayCollector = c;
  void tick(c);
  setInterval(() => void tick(c), TICK_MS).unref();
  console.log("[railway-collector] started");
}

/** What the Railway tab says about the reading, for one project (null: not running in this process). */
export function railwayCollectorStatus(projectId: number) {
  const c = g.__railwayCollector;
  if (!c) return null;
  return { running: true, everyMs: TICK_MS, project: c.seen.get(projectId) ?? null, lastTick: c.lastTick, pausedUntil: c.pausedUntil > Date.now() ? c.pausedUntil : null, error: c.tickError };
}

async function tick(c: Collector) {
  if (Date.now() < c.pausedUntil) return;
  try {
    for (const link of await railwayLinks()) {
      const seen = c.seen.get(link.projectId) ?? { lastRun: null, lines: 0, problems: 0, services: 0, error: null };
      c.seen.set(link.projectId, seen);
      try {
        await collect(link, seen);
        seen.error = null;
      } catch (e) {
        seen.error = (e as Error).message;
        if (e instanceof RailwayApiError && e.status === 429) {
          c.pausedUntil = Date.now() + PAUSE_MS;
          break;
        }
      }
    }
    c.lastTick = Date.now();
    c.tickError = null;
  } catch (e) {
    c.tickError = (e as Error).message;
  }
}

type Link = Awaited<ReturnType<typeof railwayLinks>>[number];
type Agg = { p: Problem; count: number; at: number; recent: unknown[]; paths: Set<string>; services: Set<string>; deploymentId: string };

async function collect(link: Link, seen: Seen) {
  const end = Date.now() - LAG_MS;
  const start = link.collectedUntil?.getTime() ?? end - LOOKBACK_MS;
  if (end <= start) return;
  const services = await railwayServicesOf(link.token, link.kind, link.railwayProjectId, link.environmentId);
  seen.services = services.length;
  const found = new Map<string, Agg>();
  const add = (p: Problem, service: string, deploymentId: string, at: number) => {
    const cur = found.get(p.fingerprint) ?? { p, count: 0, at, recent: [], paths: new Set<string>(), services: new Set<string>(), deploymentId };
    cur.count++;
    cur.at = Math.max(cur.at, at);
    cur.recent = [{ at, path: p.path, method: p.method, status: p.status, message: p.message.slice(0, 1000), deployment: deploymentId, service }, ...cur.recent].slice(0, RECENT_KEPT);
    if (p.path) cur.paths.add(p.path);
    cur.services.add(service);
    found.set(p.fingerprint, cur);
  };
  for (const s of services) {
    const d = s.latest;
    if (!d) continue;
    if (d.status === "FAILED" || d.status === "CRASHED") await recordFailure(link, s.name, { ...d, environmentId: link.environmentId });
    // (only a running deployment has a service printing and answering)
    if (stateOf(d.status) !== "ok") continue;
    const lines = await deployLogsOf(link.token, link.kind, d.id, { filter: "@level:error OR @level:warn", since: start, until: end, limit: LIMIT });
    const requests = await httpLogsOf(link.token, link.kind, d.id, start, end, "@httpStatus:>=500", LIMIT);
    seen.lines += lines.length + requests.length;
    for (const l of lines) {
      const p = problemOf(deployRuntimeLine(l));
      if (p) add(p, s.name, d.id, l.at ?? end);
    }
    for (const h of requests) {
      const p = problemOf(httpRuntimeLine(h));
      if (p) add(p, s.name, d.id, Date.parse(h.timestamp) || end);
    }
  }
  for (const a of found.values()) {
    seen.problems += a.count;
    await upsert(link.projectId, a);
  }
  await setCollectedUntil(link.projectId, new Date(end));
  seen.lastRun = Date.now();
}

/** One problem seen `count` more times: a new issue, or the existing one counted (and back if it was dismissed). */
async function upsert(projectId: number, a: Agg) {
  const at = new Date(a.at);
  await db.execute(sql`
    insert into railway_issues (project_id, fingerprint, kind, level, title, sample, recent, paths, services, count, first_seen, last_seen, last_deployment_id)
    values (${projectId}, ${a.p.fingerprint}, 'runtime', ${a.p.level}, ${a.p.title}, ${a.p.message}, ${JSON.stringify(a.recent)}::jsonb,
            ${JSON.stringify([...a.paths])}::jsonb, ${JSON.stringify([...a.services])}::jsonb, ${a.count}, ${at}, ${at}, ${a.deploymentId})
    on conflict (project_id, fingerprint) do update set
      count = railway_issues.count + excluded.count,
      title = excluded.title,
      sample = excluded.sample,
      last_seen = greatest(railway_issues.last_seen, excluded.last_seen),
      last_deployment_id = excluded.last_deployment_id,
      dismissed_at = null,
      recent = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(excluded.recent || railway_issues.recent) e limit ${RECENT_KEPT}) s),
      paths = (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from (select p from jsonb_array_elements_text(railway_issues.paths || excluded.paths) p limit ${PATHS_KEPT}) s),
      services = (select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from jsonb_array_elements_text(railway_issues.services || excluded.services) v)
  `);
}

/** A failed build or a crashed deployment: one issue each, with what its log says (the errors, then where it stopped). */
async function recordFailure(
  link: { projectId: number; token: string; kind: TokenKind; environmentId: string },
  service: string,
  d: { id: string; status: string; created: number; snapshotId: string | null; environmentId: string },
) {
  const kind = d.status === "FAILED" ? "build" : "crash";
  const fingerprint = buildProblemFingerprint(kind === "build" ? d.id : `crash:${d.id}`);
  const [exists] = await db.select({ id: railwayIssues.id }).from(railwayIssues).where(and(eq(railwayIssues.projectId, link.projectId), eq(railwayIssues.fingerprint, fingerprint)));
  if (exists) return;
  const log =
    kind === "build"
      ? await buildLogsOf(link.token, link.kind, { id: d.id, createdAt: new Date(d.created).toISOString(), snapshotId: d.snapshotId, environmentId: d.environmentId }).catch(() => [])
      : await deployLogsOf(link.token, link.kind, d.id, { limit: 200 }).catch(() => []);
  const meaningful = log.map((l) => l.text.replace(/\s+$/, "")).filter((t) => t && !/^\s*at\s/.test(t));
  const seenText = new Set<string>();
  const errors = meaningful.filter((t) => {
    if (!/error|failed|cannot|can't|exception|panic|fatal/i.test(t) || seenText.has(t)) return false;
    seenText.add(t);
    return true;
  });
  const tail = meaningful.slice(-12).filter((t) => !seenText.has(t));
  const sample = [...errors.slice(0, 25), ...(tail.length ? ["…", ...tail] : [])].join("\n").slice(0, 6000);
  const title = `${kind === "build" ? "Build failed" : "Deployment crashed"}: ${service}`.slice(0, 200);
  await db
    .insert(railwayIssues)
    .values({
      projectId: link.projectId, fingerprint, kind, level: "error", title, sample, count: 1,
      recent: [{ at: d.created, deployment: d.id, service }], paths: [], services: [service],
      firstSeen: new Date(d.created), lastSeen: new Date(d.created), lastDeploymentId: d.id,
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------- what the Railway tab does with them

export async function listRailwayIssues(projectId: number, withDismissed: boolean) {
  return db
    .select()
    .from(railwayIssues)
    .where(withDismissed ? eq(railwayIssues.projectId, projectId) : and(eq(railwayIssues.projectId, projectId), isNull(railwayIssues.dismissedAt)))
    .orderBy(desc(railwayIssues.lastSeen))
    .limit(200);
}

export async function dismissRailwayIssue(projectId: number, id: number, dismissed: boolean) {
  await db.update(railwayIssues).set({ dismissedAt: dismissed ? new Date() : null }).where(and(eq(railwayIssues.projectId, projectId), eq(railwayIssues.id, id)));
}

/** A ticket in the project's Tasks from an issue, with what's known about it. Answers its id (the existing one if made). */
export async function ticketFromRailwayIssue(projectId: number, slug: string, id: number, railwayProjectName: string | null): Promise<number> {
  const [i] = await db.select().from(railwayIssues).where(and(eq(railwayIssues.projectId, projectId), eq(railwayIssues.id, id)));
  if (!i) throw new Error("no such issue");
  if (i.taskId) return i.taskId;
  const recent = (i.recent as { at?: number; path?: string | null; method?: string | null; status?: number | null; service?: string }[]) ?? [];
  const paths = (i.paths as string[]) ?? [];
  const services = (i.services as string[]) ?? [];
  const where = railwayProjectName ?? slug;
  const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    i.kind === "build"
      ? `A build of ${services.join(", ") || "a service"} failed on Railway (${where}).`
      : i.kind === "crash"
        ? `A deployment of ${services.join(", ") || "a service"} crashed on Railway (${where}).`
        : `Seen in production on Railway (${where}${services.length ? `, ${services.join(", ")}` : ""}): ${i.count} time${i.count === 1 ? "" : "s"}, first ${when(i.firstSeen)}, last ${when(i.lastSeen)}.`,
    "",
    paths.length ? `Pages: ${paths.map((p) => `\`${p}\``).join(", ")}` : "",
    i.lastDeploymentId ? `Deployment: ${i.lastDeploymentId}` : "",
    "",
    i.kind === "runtime" ? "Message:" : "What its log says:",
    "```",
    i.sample.slice(0, 6000),
    "```",
  ];
  if (i.kind === "runtime" && recent.length > 1) {
    lines.push("", "Recent occurrences:");
    for (const r of recent) lines.push(`- ${r.at ? when(new Date(r.at)) : ""} ${r.service ?? ""} ${r.method ?? ""} ${r.path ?? ""} ${r.status ?? ""}`.replace(/\s+/g, " ").trim());
  }
  lines.push("", `(From Spiridus's Railway tab, issue #${i.id}.)`);
  const title = (i.kind === "runtime" ? `${i.level === "warning" ? "Production warning" : "Production error"}: ${i.title}` : i.title).slice(0, 200);
  const taskId = await addTask(projectId, title, lines.filter((l, k, a) => l !== "" || a[k - 1] !== "").join("\n"));
  await db.update(railwayIssues).set({ taskId }).where(eq(railwayIssues.id, i.id));
  return taskId;
}
