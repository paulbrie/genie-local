import "server-only";

import { cookies } from "next/headers";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Team actions start and kill Claude sessions, so they check the admin login
 * themselves, not only through proxy.ts. The admin has one login (no roles):
 * signed in = admin.
 */
export async function isAdminRequest(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}

export async function assertAdmin(): Promise<void> {
  if (!(await isAdminRequest())) throw new Error("Not signed in to the admin.");
}
