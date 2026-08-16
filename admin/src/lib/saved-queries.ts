import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { savedQueries } from "@/db/schema";

export async function listSavedQueries(
  connectionId: number,
  database: string,
) {
  return db
    .select()
    .from(savedQueries)
    .where(
      and(
        eq(savedQueries.connectionId, connectionId),
        eq(savedQueries.database, database),
      ),
    )
    .orderBy(desc(savedQueries.updatedAt));
}

export async function createSavedQuery(
  connectionId: number,
  database: string,
  name: string,
  sql: string,
) {
  const [row] = await db
    .insert(savedQueries)
    .values({ connectionId, database, name, sql })
    .returning();
  return row;
}

export async function deleteSavedQuery(id: number) {
  await db.delete(savedQueries).where(eq(savedQueries.id, id));
}
