import "server-only";

import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { browserLinks } from "@/db/schema";

export type ExtLink = { id: number; name: string; createdBy: string | null };

/**
 * The paired browser behind a request from the Spiridus Bridge extension
 * (`Authorization: Bearer <its pairing token>`), or null. The /api/browsers/ext
 * routes are let through the proxy without a session (proxy-rules.ts) and check
 * this instead: the token is as good as a signed-in session for what they do.
 */
export async function extLink(req: Request): Promise<ExtLink | null> {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer ([\w-]{20,200})$/);
  if (!m) return null;
  const hash = createHash("sha256").update(m[1]).digest("hex");
  const [row] = await db
    .select({ id: browserLinks.id, name: browserLinks.name, createdBy: browserLinks.createdBy })
    .from(browserLinks)
    .where(and(eq(browserLinks.tokenHash, hash), isNull(browserLinks.revokedAt)));
  return row ?? null;
}
