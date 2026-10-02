import "server-only";

import { cookies } from "next/headers";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Server actions can be POSTed to ANY page path (including the public /login),
// so the proxy alone can't protect them. Every exported action in
// app/actions.ts calls this first.
export async function requireAdmin(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    throw new Error("unauthorized");
  }
}
