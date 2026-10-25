import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { boards } from "@/db/schema";
import {
  emptyDoc,
  normalizeDoc,
  type AgentOp,
  type BoardDoc,
} from "@/lib/boards/core.mjs";

/** What the board hub in server.mjs exposes to route handlers (same process). */
type Hub = {
  liveDoc(id: number): BoardDoc | null;
  participants(id: number): { name: string; kind: string }[];
  applyAgentOps(
    id: number,
    agentName: string,
    ops: AgentOp[],
    opts?: { chat?: string },
  ): Promise<{ applied: number; created: Record<string, string>; errors: string[]; doc: BoardDoc } | null>;
  renamed(id: number, title: string): void;
  closed(id: number): Promise<void>;
  replaceDoc(id: number, doc: unknown): Promise<boolean>;
};

/** Null when Next runs without the custom server (e.g. a bare `next dev`). */
export function boardsHub(): Hub | null {
  return (globalThis as { __boardsHub?: Hub }).__boardsHub ?? null;
}

export type BoardSummary = {
  id: number;
  title: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  items: number;
  /** Up to a few sticky texts, for the card preview. */
  preview: string[];
};

const summaryCols = {
  id: boards.id,
  title: boards.title,
  createdBy: boards.createdBy,
  createdAt: boards.createdAt,
  updatedAt: boards.updatedAt,
  archivedAt: boards.archivedAt,
  items: sql<number>`(select count(*) from jsonb_object_keys(coalesce(${boards.doc}->'objects', '{}'::jsonb)))::int`,
  preview: sql<string[]>`coalesce((select array_agg(t) from (select o->>'text' as t from jsonb_each(coalesce(${boards.doc}->'objects', '{}'::jsonb)) as e(k, o) where o->>'type' = 'sticky' and coalesce(o->>'text', '') <> '' limit 4) s), '{}')`,
};

export async function listBoards(archived = false): Promise<BoardSummary[]> {
  return db
    .select(summaryCols)
    .from(boards)
    .where(archived ? isNotNull(boards.archivedAt) : isNull(boards.archivedAt))
    .orderBy(desc(boards.updatedAt));
}

export async function createBoard(title: string, createdBy: string | null, doc?: unknown) {
  const [row] = await db
    .insert(boards)
    .values({ title, createdBy, doc: doc ? normalizeDoc(doc) : emptyDoc() })
    .returning({ id: boards.id, title: boards.title });
  return row;
}

/** A board with its doc: the live one when it's open, else the saved one. */
export async function getBoard(id: number) {
  const [row] = await db.select().from(boards).where(eq(boards.id, id));
  if (!row) return null;
  const live = row.archivedAt ? null : boardsHub()?.liveDoc(id);
  return { ...row, doc: live ?? normalizeDoc(row.doc), live: !!live };
}

export async function renameBoard(id: number, title: string) {
  const [row] = await db
    .update(boards)
    .set({ title, updatedAt: new Date() })
    .where(eq(boards.id, id))
    .returning({ id: boards.id });
  if (row) boardsHub()?.renamed(id, title);
  return !!row;
}

export async function archiveBoard(id: number) {
  // Close it first so the hub's last save lands before the row is archived.
  await boardsHub()?.closed(id);
  const [row] = await db
    .update(boards)
    .set({ archivedAt: new Date() })
    .where(and(eq(boards.id, id), isNull(boards.archivedAt)))
    .returning({ id: boards.id });
  return !!row;
}

export async function restoreBoard(id: number) {
  const [row] = await db
    .update(boards)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(boards.id, id))
    .returning({ id: boards.id });
  return !!row;
}

/** Permanently delete an archived board. */
export async function purgeBoard(id: number) {
  const [row] = await db
    .delete(boards)
    .where(and(eq(boards.id, id), isNotNull(boards.archivedAt)))
    .returning({ id: boards.id });
  return !!row;
}

export async function duplicateBoard(id: number, createdBy: string | null) {
  const src = await getBoard(id);
  if (!src) return null;
  return createBoard(`${src.title} (copy)`, createdBy, { ...src.doc, chat: [] });
}

export function parseBoardId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
