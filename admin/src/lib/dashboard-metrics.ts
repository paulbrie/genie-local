import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects, statusSnapshots, tasks, type TaskStatus } from "@/db/schema";
import { listRuns } from "@/lib/agent-runner";
import { getRunningInfo } from "@/lib/app-run-status";
import { listChromeInstances } from "@/lib/chrome";
import { dockerStatsSummary } from "@/lib/docker";
import { runSlug } from "@/lib/run-slug";
import { listServices } from "@/lib/services";
import { readLatestStats } from "@/lib/stats";
import { listTerminals } from "@/lib/terminals";

/** One area's numbers, or null when its source failed (the card says so). */
const settle = <T,>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);

export type ProjectNavItem = {
  slug: string;
  /** An app of the project has its dev / start server up. */
  running: boolean;
  /** The ports of its running apps (apps with a port set). */
  ports: number[];
  /** Tickets not done (open + in progress). */
  openTasks: number;
  inProgress: number;
  /** One of its apps is a git repo (it has a Git tab). */
  hasGit: boolean;
};

/** Active projects with a running flag and ticket counts: the sidebar's Projects list. */
export async function getProjectNav(): Promise<ProjectNavItem[]> {
  const [rows, appRows, counts, runs] = await Promise.all([
    db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.archived, false))
      .orderBy(projects.slug),
    db
      .select({ projectId: apps.projectId, slug: apps.slug, isGit: apps.isGit, port: apps.port })
      .from(apps),
    db
      .select({
        projectId: tasks.projectId,
        status: tasks.status,
        n: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .groupBy(tasks.projectId, tasks.status),
    settle(getRunningInfo()),
  ]);
  const running = new Set((runs ?? []).map((r) => r.slug));
  return rows.map((p) => {
    const mine = counts.filter((c) => c.projectId === p.id);
    const n = (s: TaskStatus) => mine.find((c) => c.status === s)?.n ?? 0;
    const up = appRows
      .filter((a) => a.projectId === p.id)
      .filter(
        (a) =>
          running.has(runSlug(p.slug, a.slug, "dev")) ||
          running.has(runSlug(p.slug, a.slug, "start")),
      );
    return {
      slug: p.slug,
      running: up.length > 0,
      ports: up.flatMap((a) => (a.port == null ? [] : [a.port])).sort((x, y) => x - y),
      openTasks: n("open") + n("in_progress"),
      inProgress: n("in_progress"),
      hasGit: appRows.some((a) => a.projectId === p.id && a.isGit),
    };
  });
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Every area's headline numbers for the Dashboard. */
export async function getDashboardMetrics() {
  const weekAgo = new Date(Date.now() - WEEK_MS);
  const [
    nav,
    taskCounts,
    doneThisWeek,
    recentTasks,
    latestSnapshots,
    runs,
    terminals,
    docker,
    services,
    chrome,
    agentRuns,
    server,
  ] = await Promise.all([
    getProjectNav(),
    db
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(projects.archived, false))
      .groupBy(tasks.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, weekAgo)))
      .then((r) => r[0]?.n ?? 0),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        assignee: tasks.assignee,
        updatedAt: tasks.updatedAt,
        project: projects.slug,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(projects.archived, false))
      .orderBy(desc(tasks.updatedAt))
      .limit(8),
    // The newest snapshot of every app: git state per repo.
    db
      .selectDistinctOn([statusSnapshots.appId], {
        project: projects.slug,
        app: apps.slug,
        dirty: statusSnapshots.gitDirty,
        lastCommitAt: statusSnapshots.lastCommitAt,
        lastCommitHash: statusSnapshots.lastCommitHash,
      })
      .from(statusSnapshots)
      .innerJoin(apps, eq(statusSnapshots.appId, apps.id))
      .innerJoin(projects, eq(apps.projectId, projects.id))
      .where(eq(projects.archived, false))
      .orderBy(statusSnapshots.appId, desc(statusSnapshots.capturedAt)),
    settle(getRunningInfo()),
    settle(listTerminals()),
    settle(dockerStatsSummary()),
    settle(listServices()),
    settle(listChromeInstances()),
    settle(listRuns()),
    settle(readLatestStats()),
  ]);

  const count = (s: TaskStatus) => taskCounts.find((c) => c.status === s)?.n ?? 0;
  const claude = (terminals ?? []).filter((t) => t.status.startsWith("claude-") && !t.dead);
  const curated = services?.available ? services.services.filter((s) => s.curated) : null;

  return {
    projects: {
      active: nav.length,
      running: nav.filter((p) => p.running).length,
      appsRunning: runs?.length ?? null,
      appsMemBytes: runs?.reduce((n, r) => n + r.rssBytes, 0) ?? null,
      dirtyRepos: latestSnapshots.filter((s) => s.dirty).map((s) => (s.app ? `${s.project}/${s.app}` : s.project)),
      recentCommits: latestSnapshots
        .filter((s) => s.lastCommitAt)
        .sort((a, b) => +b.lastCommitAt! - +a.lastCommitAt!)
        .slice(0, 6),
      busiest: [...nav].sort((a, b) => b.openTasks - a.openTasks).filter((p) => p.openTasks > 0).slice(0, 6),
    },
    tasks: {
      open: count("open"),
      inProgress: count("in_progress"),
      done: count("done"),
      doneThisWeek,
      recent: recentTasks,
    },
    terminals: terminals && {
      total: terminals.length,
      claudeWorking: claude.filter((t) => t.status === "claude-working").length,
      claudeIdle: claude.filter((t) => t.status === "claude-idle").length,
      needsInput: claude.filter((t) => t.status === "claude-input").map((t) => t.name),
      tokens: claude.reduce((n, t) => n + (t.tokens?.total ?? 0), 0),
    },
    docker: docker?.available ? docker : null,
    services: curated && {
      active: curated.filter((s) => s.active === "active").length,
      total: curated.length,
      failed: curated.filter((s) => s.active === "failed").map((s) => s.unit),
    },
    chrome: chrome && { instances: chrome.length },
    agents: agentRuns && {
      running: agentRuns.filter((r) => r.running).length,
      failedRecently: agentRuns.filter(
        (r) => r.state === "failed" && r.endedAt && +new Date(r.endedAt) > Date.now() - WEEK_MS,
      ).length,
      total: agentRuns.length,
    },
    server,
  };
}

export type DashboardMetrics = Awaited<ReturnType<typeof getDashboardMetrics>>;
