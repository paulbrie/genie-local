import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects, tasks, type TaskStatus } from "@/db/schema";
import { getRunningInfo } from "@/lib/app-run-status";
import { runSlug } from "@/lib/run-slug";

/** A source's answer, or null when it failed. */
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
