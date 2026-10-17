import "server-only";

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  apps,
  notes,
  projects,
  taskAttachments,
  taskComments,
  tasks,
  type TaskStatus,
} from "@/db/schema";

export async function getProjectIdBySlug(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Archive (soft-delete) or restore a project. Archiving removes it from the
 * dashboard without touching the files on disk — the scan skips archived slugs
 * so it won't reappear, but the DB row and history are kept so it can be
 * restored. See scanAndPersist() and the project detail page.
 */
export async function setProjectArchived(projectId: number, archived: boolean) {
  await db
    .update(projects)
    .set({ archived, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}

/** Slugs of every archived (hidden) project, for the scan to skip. */
export async function getArchivedSlugs(): Promise<Set<string>> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.archived, true));
  return new Set(rows.map((r) => r.slug));
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
  const [created] = await db
    .insert(tasks)
    .values({ projectId, title, description, position })
    .returning({ id: tasks.id });
  return created.id;
}

/** True if the task exists and belongs to the project. */
export async function taskInProject(projectId: number, taskId: number) {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .limit(1);
  return !!task;
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
      // Not an edit of the task: leave updatedAt alone (cards show it).
      .set({ position })
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)));
    position += 1;
  }
}

/** Set a task's status (the DB trigger keeps the legacy `done` flag in step). */
export async function setTaskStatus(
  projectId: number,
  taskId: number,
  status: TaskStatus,
) {
  // Only a real change counts as an update (a drop in the same column doesn't).
  await db
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.projectId, projectId),
        ne(tasks.status, status),
      ),
    );
}

/** A board drop: the task's new column plus the project's new order. */
export async function moveTask(
  projectId: number,
  taskId: number,
  status: TaskStatus,
  orderedIds: number[],
) {
  await setTaskStatus(projectId, taskId, status);
  await reorderTasks(projectId, orderedIds);
}

export async function updateTask(
  projectId: number,
  taskId: number,
  fields: {
    title: string;
    description: string | null;
    status: TaskStatus;
    commitSha: string | null;
  },
) {
  await db
    .update(tasks)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
}

export async function deleteTask(projectId: number, taskId: number) {
  await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
}

export async function getTask(projectId: number, taskId: number) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** Record the delegation on the task and leave a line in its thread. */
export async function assignTask(
  projectId: number,
  taskId: number,
  assignee: string,
  note: string | null,
) {
  await db
    .update(tasks)
    .set({ assignee, assignedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  await db.insert(taskComments).values({
    taskId,
    author: "user",
    body: `Delegated to ${assignee}${note ? `: ${note}` : ""}`,
  });
}

/** Every comment on the project's tasks, oldest first (thread order). */
export async function getTaskComments(projectId: number) {
  return db
    .select({ comment: taskComments })
    .from(taskComments)
    .innerJoin(tasks, eq(taskComments.taskId, tasks.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
    .then((rows) => rows.map((r) => r.comment));
}

/** Comment on a task as the user; false if the task isn't in the project. */
export async function addTaskComment(
  projectId: number,
  taskId: number,
  body: string,
): Promise<boolean> {
  if (!(await taskInProject(projectId, taskId))) return false;
  await db.insert(taskComments).values({ taskId, author: "user", body });
  return true;
}

/** Every attachment on the project's tasks, oldest first. */
export async function getTaskAttachments(projectId: number) {
  return db
    .select({ attachment: taskAttachments })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(taskAttachments.createdAt), asc(taskAttachments.id))
    .then((rows) => rows.map((r) => r.attachment));
}

export async function getTaskAttachment(id: number) {
  const [row] = await db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.id, id))
    .limit(1);
  return row ?? null;
}

export async function insertTaskAttachments(
  rows: (typeof taskAttachments.$inferInsert)[],
) {
  if (rows.length) await db.insert(taskAttachments).values(rows);
}

/** Delete an attachment row of the project; returns its file path, if any. */
export async function deleteTaskAttachment(
  projectId: number,
  attachmentId: number,
): Promise<string | null> {
  const owned = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  const [row] = await db
    .delete(taskAttachments)
    .where(
      and(
        eq(taskAttachments.id, attachmentId),
        inArray(taskAttachments.taskId, owned),
      ),
    )
    .returning({ path: taskAttachments.path });
  return row?.path ?? null;
}

export async function deleteTaskComment(projectId: number, commentId: number) {
  const owned = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  await db
    .delete(taskComments)
    .where(
      and(eq(taskComments.id, commentId), inArray(taskComments.taskId, owned)),
    );
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
