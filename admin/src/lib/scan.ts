import "server-only";

import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects, statusSnapshots } from "@/db/schema";
import {
  collectAllProjects,
  collectProject,
  type AppSignals,
  type ProjectSignals,
} from "@/lib/signals";

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function upsertProject(sig: ProjectSignals): Promise<number> {
  const [row] = await db
    .insert(projects)
    .values({ slug: sig.slug, path: sig.path, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: projects.slug,
      set: { path: sig.path, updatedAt: new Date() },
    })
    .returning({ id: projects.id });
  return row.id;
}

async function upsertApp(projectId: number, app: AppSignals): Promise<number> {
  const [row] = await db
    .insert(apps)
    .values({
      projectId,
      slug: app.slug,
      path: app.path,
      name: app.name,
      isGit: app.isGit,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [apps.projectId, apps.slug],
      set: {
        path: app.path,
        name: app.name,
        isGit: app.isGit,
        updatedAt: new Date(),
      },
    })
    .returning({ id: apps.id });
  return row.id;
}

async function insertSnapshot(appId: number, app: AppSignals) {
  await db.insert(statusSnapshots).values({
    appId,
    gitBranch: app.git.branch,
    gitDirty: app.git.dirty,
    ahead: app.git.ahead,
    behind: app.git.behind,
    lastCommitAt: toDate(app.git.lastCommitAt),
    lastCommitHash: app.git.lastCommitHash,
    dirMtime: toDate(app.fs.dirMtime),
    sizeBytes: app.fs.sizeBytes,
    raw: app,
  });
}

/** Persist one project: upsert project + each app, snapshot every app. */
async function persistProject(sig: ProjectSignals): Promise<void> {
  const projectId = await upsertProject(sig);
  await Promise.all(
    sig.apps.map(async (app) => {
      const appId = await upsertApp(projectId, app);
      await insertSnapshot(appId, app);
    }),
  );
}

/** Scan all projects on disk, upsert the registry, snapshot each app. */
export async function scanAndPersist(): Promise<ProjectSignals[]> {
  const signals = await collectAllProjects();
  await Promise.all(signals.map(persistProject));
  return signals;
}

/** Re-scan a single project by slug. */
export async function rescanProject(slug: string): Promise<ProjectSignals> {
  const sig = await collectProject(slug);
  await persistProject(sig);
  return sig;
}

export type ProjectRow = typeof projects.$inferSelect;
export type AppRow = typeof apps.$inferSelect;
export type SnapshotRow = typeof statusSnapshots.$inferSelect;

export type AppWithLatest = { app: AppRow; latest: SnapshotRow | null };
export type ProjectWithApps = { project: ProjectRow; apps: AppWithLatest[] };

/** Load every project with its apps and each app's latest snapshot. */
export async function getProjectsWithApps(): Promise<ProjectWithApps[]> {
  const projectRows = await db.select().from(projects).orderBy(projects.slug);
  if (projectRows.length === 0) return [];

  const projectIds = projectRows.map((p) => p.id);
  const appRows = await db
    .select()
    .from(apps)
    .where(inArray(apps.projectId, projectIds))
    .orderBy(apps.slug);

  const latestByApp = await latestSnapshotByApp(appRows.map((a) => a.id));

  const appsByProject = new Map<number, AppWithLatest[]>();
  for (const app of appRows) {
    const list = appsByProject.get(app.projectId) ?? [];
    list.push({ app, latest: latestByApp.get(app.id) ?? null });
    appsByProject.set(app.projectId, list);
  }

  return projectRows.map((project) => ({
    project,
    apps: appsByProject.get(project.id) ?? [],
  }));
}

/** Map of appId -> its most recent snapshot. */
async function latestSnapshotByApp(
  appIds: number[],
): Promise<Map<number, SnapshotRow>> {
  const map = new Map<number, SnapshotRow>();
  if (appIds.length === 0) return map;
  const snaps = await db
    .select()
    .from(statusSnapshots)
    .where(inArray(statusSnapshots.appId, appIds))
    .orderBy(desc(statusSnapshots.capturedAt));
  for (const s of snaps) {
    if (!map.has(s.appId)) map.set(s.appId, s);
  }
  return map;
}

export type ProjectDetail = {
  project: ProjectRow;
  apps: Array<{ app: AppRow; snapshots: SnapshotRow[] }>;
};

/** Load a single project with its apps and each app's snapshot history. */
export async function getProjectDetail(
  slug: string,
): Promise<ProjectDetail | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!project) return null;

  const appRows = await db
    .select()
    .from(apps)
    .where(eq(apps.projectId, project.id))
    .orderBy(apps.slug);

  const appsWithHistory = await Promise.all(
    appRows.map(async (app) => {
      const snapshots = await db
        .select()
        .from(statusSnapshots)
        .where(eq(statusSnapshots.appId, app.id))
        .orderBy(desc(statusSnapshots.capturedAt))
        .limit(50);
      return { app, snapshots };
    }),
  );

  return { project, apps: appsWithHistory };
}
