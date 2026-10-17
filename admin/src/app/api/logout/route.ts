import { NextRequest, NextResponse } from "next/server";

import { clientIp, endSession, sessionIdOf } from "@/lib/admin-auth-log";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // Only a real session's logout is logged (and ends it in the session list).
  if (token && (await verifySessionToken(token))) {
    await endSession(sessionIdOf(token), clientIp(req), req.headers.get("user-agent"));
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
