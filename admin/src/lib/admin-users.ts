import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { adminUsers, type AdminUser } from "@/db/schema";
import { accountDecision, normalizeEmail, type AccountDecision } from "@/lib/genie-sso-core";
import { clearUserAccess } from "@/lib/session-access.mjs";

/** The local accounts (Users page): who may Sign in with Genie here. */
export async function listUsers(): Promise<AdminUser[]> {
  return db.select().from(adminUsers).orderBy(asc(adminUsers.email));
}

export async function addUser(email: string, name: string): Promise<AdminUser> {
  const [row] = await db.insert(adminUsers).values({ email: normalizeEmail(email), name }).returning();
  return row;
}

// (a change applies to open sessions at once: the cached access answer is dropped; open terminal and board sockets
// close at server.mjs's next re-check)
export async function setUserEnabled(id: number, enabled: boolean) {
  const [row] = await db.update(adminUsers).set({ enabled }).where(eq(adminUsers.id, id)).returning({ email: adminUsers.email });
  clearUserAccess(row?.email);
}

export async function removeUser(id: number) {
  const [row] = await db.delete(adminUsers).where(eq(adminUsers.id, id)).returning({ email: adminUsers.email });
  clearUserAccess(row?.email);
}

/** Whether the email may sign in, and its row when there is one. */
export async function accountFor(email: string): Promise<{ decision: AccountDecision; user: AdminUser | null }> {
  const rows = await db.select().from(adminUsers).where(eq(adminUsers.email, normalizeEmail(email))).limit(1);
  return { decision: accountDecision(rows, email), user: rows[0] ?? null };
}

export async function noteLogin(id: number) {
  await db.update(adminUsers).set({ lastLoginAt: sql`now()` }).where(eq(adminUsers.id, id));
}
