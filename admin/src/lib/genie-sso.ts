import "server-only";

import { lt, sql } from "drizzle-orm";

import { db } from "@/db";
import { adminSsoJtis } from "@/db/schema";
import { createJwksCache, readGenieIdentity, type GenieIdentity } from "@/lib/genie-sso-core";

export const BASE_PATH = process.env.APP_BASE_PATH ?? "/admin";
/** The nonce cookie is only sent back to the Sign in with Genie routes. */
export const NONCE_COOKIE_PATH = `${BASE_PATH}/api/auth/genie`;

/** This server's genie identity, or null when Sign in with Genie isn't set up here. */
export function genieIdentity(): GenieIdentity | null {
  return readGenieIdentity();
}

// One cache per process, kept across dev hot reloads.
const g = globalThis as unknown as { __genieJwks?: ReturnType<typeof createJwksCache> };
export const jwks = (g.__genieJwks ??= createJwksCache());

/**
 * The replay store: a jti is inserted once; a second insert of it finds the
 * row and is refused. A table rather than a map in memory because prod and dev
 * are two processes for the same instance (same audience, same database), and
 * a restart mid-sign-in shouldn't forget one. Expired rows go on each insert.
 */
export async function markJtiUsed(jti: string, expiresAtMs: number): Promise<boolean> {
  await db.delete(adminSsoJtis).where(lt(adminSsoJtis.expiresAt, sql`now()`));
  const rows = await db
    .insert(adminSsoJtis)
    .values({ jti, expiresAt: new Date(expiresAtMs) })
    .onConflictDoNothing()
    .returning({ jti: adminSsoJtis.jti });
  return rows.length === 1;
}

/** The origin the browser is on (nginx passes Host and X-Forwarded-Proto). */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}
