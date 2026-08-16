import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { connections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

export type Engine = "postgres" | "mysql";

export type ConnectionInput = {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  username: string;
  password?: string | null;
  defaultDatabase?: string | null;
};

/** Connection as exposed to the client — never includes the password. */
export type SafeConnection = {
  id: number;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  username: string;
  defaultDatabase: string | null;
  hasPassword: boolean;
};

/** Connection with the decrypted password, for server-side driver use only. */
export type ResolvedConnection = Omit<SafeConnection, "hasPassword"> & {
  password: string | null;
};

function toSafe(row: typeof connections.$inferSelect): SafeConnection {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as Engine,
    host: row.host,
    port: row.port,
    username: row.username,
    defaultDatabase: row.defaultDatabase,
    hasPassword: !!row.passwordEnc,
  };
}

export async function listConnections(): Promise<SafeConnection[]> {
  const rows = await db.select().from(connections).orderBy(connections.name);
  return rows.map(toSafe);
}

export async function getResolvedConnection(
  id: number,
): Promise<ResolvedConnection | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as Engine,
    host: row.host,
    port: row.port,
    username: row.username,
    defaultDatabase: row.defaultDatabase,
    password: row.passwordEnc ? decrypt(row.passwordEnc) : null,
  };
}

export async function createConnection(
  input: ConnectionInput,
): Promise<SafeConnection> {
  const [row] = await db
    .insert(connections)
    .values({
      name: input.name,
      engine: input.engine,
      host: input.host,
      port: input.port,
      username: input.username,
      passwordEnc: input.password ? encrypt(input.password) : null,
      defaultDatabase: input.defaultDatabase ?? null,
    })
    .returning();
  return toSafe(row);
}

export async function updateConnection(
  id: number,
  input: ConnectionInput,
): Promise<SafeConnection | null> {
  // Only re-encrypt the password when a new one was supplied (undefined = keep).
  const set: Partial<typeof connections.$inferInsert> = {
    name: input.name,
    engine: input.engine,
    host: input.host,
    port: input.port,
    username: input.username,
    defaultDatabase: input.defaultDatabase ?? null,
    updatedAt: new Date(),
  };
  if (input.password !== undefined) {
    set.passwordEnc = input.password ? encrypt(input.password) : null;
  }
  const [row] = await db
    .update(connections)
    .set(set)
    .where(eq(connections.id, id))
    .returning();
  return row ? toSafe(row) : null;
}

export async function deleteConnection(id: number): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id));
}
