import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { connections, savedQueries } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { connKey, type FoundConn } from "@/lib/db-discovery-core";

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
  /** found on this box (it follows its source, so it isn't edited or removed by hand); false: added by hand */
  found: boolean;
  /** where it was found (empty: added by hand, or no longer found and kept for its saved queries) */
  from: string[];
  /** something answers on its port (null: added by hand, not checked) */
  running: boolean | null;
};

/** Connection with the decrypted password, for server-side driver use only. */
export type ResolvedConnection = Omit<SafeConnection, "hasPassword" | "found" | "from" | "running"> & {
  password: string | null;
};

type FoundNow = ReadonlyMap<string, Pick<FoundConn, "from"> & { running: boolean }>;

function toSafe(row: typeof connections.$inferSelect, found?: FoundNow): SafeConnection {
  const now = row.autoKey ? found?.get(row.autoKey) : undefined;
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as Engine,
    host: row.host,
    port: row.port,
    username: row.username,
    defaultDatabase: row.defaultDatabase,
    hasPassword: !!row.passwordEnc,
    found: !!row.autoKey,
    from: now?.from ?? [],
    running: row.autoKey ? (now?.running ?? false) : null,
  };
}

/** Every connection, by name; `found`: what was found on this box just now (db-discovery), for where each comes from. */
export async function listConnections(found?: FoundNow): Promise<SafeConnection[]> {
  const rows = await db.select().from(connections).orderBy(connections.name);
  return rows.map((r) => toSafe(r, found));
}

/**
 * The explorer's connections in line with the databases found on this box: one new is added, one changed (a
 * container's port, a password) is updated, one gone is removed unless it has saved queries. One that's the same as
 * a connection added by hand (same server and user) is left to that one.
 */
export async function syncFoundConnections(found: readonly FoundConn[]): Promise<void> {
  const rows = await db.select().from(connections);
  const byHand = new Set(rows.filter((r) => !r.autoKey).map((r) => connKey({ ...r, engine: r.engine as Engine })));
  const auto = new Map(rows.filter((r) => r.autoKey).map((r) => [r.autoKey!, r]));
  const wanted = found.filter((f) => !byHand.has(f.key));
  for (const f of wanted) {
    const row = auto.get(f.key);
    const values = { name: f.name, engine: f.engine, host: f.host, port: f.port, username: f.username, defaultDatabase: f.defaultDatabase };
    if (!row) {
      await db
        .insert(connections)
        .values({ ...values, passwordEnc: f.password ? encrypt(f.password) : null, autoKey: f.key })
        .onConflictDoNothing();
      continue;
    }
    const password = row.passwordEnc ? decrypt(row.passwordEnc) : null;
    const same = (Object.keys(values) as (keyof typeof values)[]).every((k) => row[k] === values[k]) && password === f.password;
    if (!same)
      await db
        .update(connections)
        .set({ ...values, passwordEnc: f.password ? encrypt(f.password) : null, updatedAt: new Date() })
        .where(eq(connections.id, row.id));
  }
  const keep = new Set(wanted.map((f) => f.key));
  for (const [key, row] of auto) {
    if (keep.has(key)) continue;
    const [saved] = await db.select({ id: savedQueries.id }).from(savedQueries).where(eq(savedQueries.connectionId, row.id)).limit(1);
    if (!saved) await db.delete(connections).where(eq(connections.id, row.id));
  }
}

/** Whether the connection was found on this box (and so follows its source instead of being edited by hand). */
export async function isFoundConnection(id: number): Promise<boolean> {
  const [row] = await db.select({ autoKey: connections.autoKey }).from(connections).where(eq(connections.id, id)).limit(1);
  return !!row?.autoKey;
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
