import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { apps, notes, projects, tasks } from "@/db/schema";

export async function getProjectIdBySlug(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

export async function getNotes(projectId: number) {
  return db
    .select()
    .from(notes)
    .where(eq(notes.projectId, projectId))
    .orderBy(asc(notes.position), desc(notes.createdAt));
}

export async function getTasks(projectId: number) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.position), desc(tasks.createdAt));
}

export async function addNote(projectId: number, body: string) {
  const [row] = await db
    .select({ min: sql<number>`coalesce(min(${notes.position}), 0)` })
    .from(notes)
    .where(eq(notes.projectId, projectId));
  await db
    .insert(notes)
    .values({ projectId, body, position: Number(row?.min ?? 0) - 1 });
}

export async function updateNote(
  projectId: number,
  noteId: number,
  body: string,
) {
  await db
    .update(notes)
    .set({ body })
    .where(and(eq(notes.id, noteId), eq(notes.projectId, projectId)));
}

export async function deleteNote(projectId: number, noteId: number) {
  await db
    .delete(notes)
    .where(and(eq(notes.id, noteId), eq(notes.projectId, projectId)));
}

export async function reorderNotes(projectId: number, orderedIds: number[]) {
  const owned = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.projectId, projectId), inArray(notes.id, orderedIds)));
  const ownedSet = new Set(owned.map((r) => r.id));
  let position = 0;
  for (const id of orderedIds) {
    if (!ownedSet.has(id)) continue;
    await db
      .update(notes)
      .set({ position })
      .where(and(eq(notes.id, id), eq(notes.projectId, projectId)));
    position += 1;
  }
}

export async function addTask(
  projectId: number,
  title: string,
  description?: string | null,
) {
  // New tasks go to the top of the list (smallest position).
  const [row] = await db
    .select({ min: sql<number>`coalesce(min(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  const position = Number(row?.min ?? 0) - 1;
  await db.insert(tasks).values({ projectId, title, description, position });
}

/** Persist a manual ordering: `orderedIds` top→bottom become position 0..n. */
export async function reorderTasks(projectId: number, orderedIds: number[]) {
  // Only reorder ids that actually belong to this project.
  const owned = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, orderedIds)));
  const ownedSet = new Set(owned.map((r) => r.id));
  let position = 0;
  for (const id of orderedIds) {
    if (!ownedSet.has(id)) continue;
    await db
      .update(tasks)
      .set({ position, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)));
    position += 1;
  }
}

export async function setTaskDone(
  projectId: number,
  taskId: number,
  done: boolean,
) {
  await db
    .update(tasks)
    .set({ done, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
}

export async function updateTask(
  projectId: number,
  taskId: number,
  fields: { title: string; description: string | null },
) {
  await db
    .update(tasks)
    .set({
      title: fields.title,
      description: fields.description,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
}

export async function deleteTask(projectId: number, taskId: number) {
  await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
}

/** Resolve the info needed to start/stop an app: its dir, port, and slugs. */
export async function getAppRunTarget(projectId: number, appId: number) {
  const [row] = await db
    .select({
      appSlug: apps.slug,
      path: apps.path,
      port: apps.port,
      projectSlug: projects.slug,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.projectId, projects.id))
    .where(and(eq(apps.id, appId), eq(apps.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** Set (or clear, with null) an app's port. Scoped to the owning project. */
export async function updateAppPort(
  projectId: number,
  appId: number,
  port: number | null,
) {
  await db
    .update(apps)
    .set({ port, updatedAt: new Date() })
    .where(and(eq(apps.id, appId), eq(apps.projectId, projectId)));
}
