import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { boardSnapshots } from "@/db/schema";
import { normalizeDoc, type BoardDoc } from "@/lib/boards/core.mjs";

export type HistoryEntry = {
  id: number;
  label: string | null;
  authors: string | null;
  changes: number;
  createdAt: Date;
};

/** A board's history, oldest first, so a slider reads left to right. */
export async function listHistory(boardId: number): Promise<HistoryEntry[]> {
  const rows = await db
    .select({
      id: boardSnapshots.id,
      label: boardSnapshots.label,
      authors: boardSnapshots.authors,
      changes: boardSnapshots.changes,
      createdAt: boardSnapshots.createdAt,
    })
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId))
    .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id))
    .limit(60);
  return rows.reverse();
}

/** One point in a board's history, as a doc. */
export async function getSnapshot(boardId: number, snapshotId: number): Promise<BoardDoc | null> {
  const [row] = await db
    .select({ doc: boardSnapshots.doc })
    .from(boardSnapshots)
    .where(and(eq(boardSnapshots.id, snapshotId), eq(boardSnapshots.boardId, boardId)));
  return row ? normalizeDoc(row.doc) : null;
}
