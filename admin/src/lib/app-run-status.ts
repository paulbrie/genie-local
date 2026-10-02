import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects } from "@/db/schema";
import { runSlug } from "@/lib/run-slug";
import {
  listeningPortPids,
  listRunningPids,
  pgidOf,
  rssBytesByProcessGroup,
  type RunInfo,
} from "@/lib/runner";

/**
 * Which app servers are live, from two independent signals unioned together:
 *
 *  1. **pid file** — a tracked process (started from the admin UI) still alive, and
 *  2. **port** — something actually LISTENING on the app's configured port.
 *
 * (2) is what keeps the dashboard honest when a server wasn't started through the
 * runner — e.g. `npm run dev` in a terminal — or when a failed restart left a
 * stale pid file pointing at a dead process while the real server kept the port.
 * Without it, such an app reads as "not running" on the dashboard even though it
 * clearly serves traffic.
 *
 * Both the initial SSR load and the dashboard's status poll go through here, so
 * the two stay consistent.
 */
export async function getRunningInfo(): Promise<RunInfo[]> {
  const [pidRuns, portPids, rssByPgid, appRows] = await Promise.all([
    listRunningPids(),
    listeningPortPids(),
    rssBytesByProcessGroup(),
    db
      .select({
        projectSlug: projects.slug,
        appSlug: apps.slug,
        port: apps.port,
      })
      .from(apps)
      .innerJoin(projects, eq(apps.projectId, projects.id)),
  ]);

  // Apps started detached have pgid = the stored pid, so the group's RSS is
  // keyed by that pid.
  const out: RunInfo[] = pidRuns.map(({ slug, pid }) => ({
    slug,
    pid,
    rssBytes: rssByPgid.get(pid) ?? 0,
  }));
  const have = new Set(out.map((r) => r.slug));

  for (const app of appRows) {
    if (app.port == null) continue;
    const pid = portPids.get(app.port);
    if (pid == null) continue;
    const devSlug = runSlug(app.projectSlug, app.appSlug, "dev");
    const startSlug = runSlug(app.projectSlug, app.appSlug, "start");
    // Already accounted for by a live pid file — don't double-count.
    if (have.has(devSlug) || have.has(startSlug)) continue;
    // Report under the dev slug so isAppServerRunning() matches; memory is the
    // RSS of the listening process's whole group.
    const pgid = (await pgidOf(pid)) ?? pid;
    out.push({ slug: devSlug, pid, rssBytes: rssByPgid.get(pgid) ?? 0 });
    have.add(devSlug);
  }

  return out;
}
