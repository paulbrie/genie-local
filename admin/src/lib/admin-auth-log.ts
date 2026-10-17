import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { adminLogins, adminSessions } from "@/db/schema";

/** Why a login failed, as stored (reason) and as shown. */
export const LOGIN_FAILURES = {
  wrong_password: "Wrong password (the username was right)",
  unknown_user: "Unknown username",
  rate_limited: "Too many failed attempts from this IP (locked for 15 min)",
  bad_request: "Malformed request (no username / password sent)",
  not_configured: "No ADMIN_PASSWORD set on the server: every login fails",
  forbidden_origin: "Sent from another website (cross-origin request blocked)",
} as const;
export type LoginFailure = keyof typeof LOGIN_FAILURES;

/** A session seen this recently counts as connected (the top bar beats every 20 s). */
export const CONNECTED_MS = 60_000;

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** A session's id: a hash of its cookie (never stored itself). */
export function sessionIdOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** Logging must never break a login: failures here are only reported. */
async function quietly(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.error(`[auth-log] ${what}:`, err instanceof Error ? err.message : err);
  }
}

export async function recordLoginAttempt(entry: {
  ok: boolean;
  reason?: LoginFailure;
  username?: string | null;
  ip: string;
  userAgent: string | null;
  sessionId?: string;
}) {
  await quietly("login", () =>
    db.insert(adminLogins).values({
      event: "login",
      ok: entry.ok,
      reason: entry.reason ?? null,
      // Bounded: whatever was typed in the username box.
      username: entry.username?.slice(0, 200) ?? null,
      ip: entry.ip,
      userAgent: entry.userAgent?.slice(0, 500) ?? null,
      sessionId: entry.sessionId ?? null,
    }),
  );
}

export async function openSession(id: string, ip: string, userAgent: string | null) {
  await quietly("open session", () =>
    db
      .insert(adminSessions)
      .values({ id, ip, userAgent: userAgent?.slice(0, 500) ?? null, via: "login" })
      .onConflictDoNothing(),
  );
}

export async function endSession(id: string, ip: string, userAgent: string | null) {
  await quietly("logout", async () => {
    await db.update(adminSessions).set({ endedAt: new Date() }).where(eq(adminSessions.id, id));
    await db.insert(adminLogins).values({
      event: "logout",
      ok: true,
      ip,
      userAgent: userAgent?.slice(0, 500) ?? null,
      sessionId: id,
    });
  });
}

/** The heartbeat: this session is here now (created if it predates tracking). */
export async function touchSession(id: string, ip: string, userAgent: string | null) {
  await quietly("heartbeat", () =>
    db
      .insert(adminSessions)
      .values({ id, ip, userAgent: userAgent?.slice(0, 500) ?? null, via: "token" })
      .onConflictDoUpdate({
        target: adminSessions.id,
        set: { lastSeenAt: sql`now()`, ip, userAgent: userAgent?.slice(0, 500) ?? null },
      }),
  );
}

/** Sessions with an open tab right now. */
export async function connectedSessions() {
  return db
    .select()
    .from(adminSessions)
    .where(
      and(
        isNull(adminSessions.endedAt),
        gte(adminSessions.lastSeenAt, new Date(Date.now() - CONNECTED_MS)),
      ),
    )
    .orderBy(desc(adminSessions.lastSeenAt));
}

/** Sessions seen in the last `days`, each with its state now. */
export async function recentSessions(days = 7) {
  const now = Date.now();
  const rows = await db
    .select()
    .from(adminSessions)
    .where(gte(adminSessions.lastSeenAt, new Date(now - days * 86_400_000)))
    .orderBy(desc(adminSessions.lastSeenAt))
    .limit(200);
  return rows.map((s) => ({
    ...s,
    state: s.endedAt
      ? ("Logged out" as const)
      : now - +s.lastSeenAt < CONNECTED_MS
        ? ("Connected" as const)
        : ("Away" as const),
  }));
}

export async function recentLogins(opts: { failedOnly?: boolean; limit?: number } = {}) {
  return db
    .select()
    .from(adminLogins)
    .where(opts.failedOnly ? eq(adminLogins.ok, false) : undefined)
    .orderBy(desc(adminLogins.at))
    .limit(opts.limit ?? 300);
}

/** Failed logins in the last 24 h, by reason. */
export async function failuresLastDay() {
  return db
    .select({ reason: adminLogins.reason, n: sql<number>`count(*)::int` })
    .from(adminLogins)
    .where(and(eq(adminLogins.ok, false), gte(adminLogins.at, new Date(Date.now() - 86_400_000))))
    .groupBy(adminLogins.reason);
}
