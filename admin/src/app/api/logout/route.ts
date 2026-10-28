import { NextRequest, NextResponse } from "next/server";

import { recordActivity } from "@/lib/activity";
import { clientIp, endSession, sessionIdOf } from "@/lib/admin-auth-log";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // Only a real session's logout is logged (and ends it in the session list).
  if (token && (await verifySessionToken(token))) {
    const id = sessionIdOf(token);
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent");
    await endSession(id, ip, userAgent);
    recordActivity("auth.logout", { session: id, ip, ua: userAgent });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
