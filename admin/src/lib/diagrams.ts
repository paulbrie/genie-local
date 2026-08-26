import "server-only";

import { desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/db";
import { diagrams, type Diagram } from "@/db/schema";

export type { Diagram };

/**
 * Text diagram languages we accept. Only 'mermaid' is rendered in the UI today;
 * the column exists so d2/dot can be added later without a schema change.
 */
export const DIAGRAM_FORMATS = ["mermaid"] as const;
export type DiagramFormat = (typeof DIAGRAM_FORMATS)[number];

/** Upper bound on a diagram's source, guarding both the DB and the renderer. */
export const MAX_DIAGRAM_BYTES = 100_000;

/** Active (non-archived) diagrams, newest-updated first. */
export async function listDiagrams(): Promise<Diagram[]> {
  return db
    .select()
    .from(diagrams)
    .where(isNull(diagrams.archivedAt))
    .orderBy(desc(diagrams.updatedAt));
}

/** Soft-deleted diagrams, most-recently-archived first. */
export async function listArchivedDiagrams(): Promise<Diagram[]> {
  return db
    .select()
    .from(diagrams)
    .where(isNotNull(diagrams.archivedAt))
    .orderBy(desc(diagrams.archivedAt));
}

export async function getDiagram(id: number): Promise<Diagram | null> {
  const [row] = await db.select().from(diagrams).where(eq(diagrams.id, id));
  return row ?? null;
}

export async function createDiagram(input: {
  title: string;
  source: string;
  format?: DiagramFormat;
}): Promise<Diagram> {
  const [row] = await db
    .insert(diagrams)
    .values({
      title: input.title,
      source: input.source,
      format: input.format ?? "mermaid",
    })
    .returning();
  return row;
}

export async function updateDiagram(
  id: number,
  patch: { title?: string; source?: string; format?: DiagramFormat },
): Promise<Diagram | null> {
  const [row] = await db
    .update(diagrams)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(diagrams.id, id))
    .returning();
  return row ?? null;
}

/** Rename a diagram (title only). Returns the row, or null if it doesn't exist. */
export async function renameDiagram(
  id: number,
  title: string,
): Promise<Diagram | null> {
  const [row] = await db
    .update(diagrams)
    .set({ title, updatedAt: new Date() })
    .where(eq(diagrams.id, id))
    .returning();
  return row ?? null;
}

/** Soft-delete: mark archived so it drops out of the main list but is restorable. */
export async function archiveDiagram(id: number): Promise<Diagram | null> {
  const [row] = await db
    .update(diagrams)
    .set({ archivedAt: new Date() })
    .where(eq(diagrams.id, id))
    .returning();
  return row ?? null;
}

/** Bring a soft-deleted diagram back into the active list. */
export async function restoreDiagram(id: number): Promise<Diagram | null> {
  const [row] = await db
    .update(diagrams)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(diagrams.id, id))
    .returning();
  return row ?? null;
}

/** Permanent, irreversible delete. */
export async function purgeDiagram(id: number): Promise<void> {
  await db.delete(diagrams).where(eq(diagrams.id, id));
}
