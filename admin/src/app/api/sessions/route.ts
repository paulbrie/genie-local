// GET: the top bar's heartbeat. Marks this browser's session as seen now and
// returns the sessions connected right now (a tab open in the last minute).
import { NextRequest, NextResponse } from "next/server";

import {
  clientIp,
  connectedSessions,
  sessionIdOf,
  touchSession,
} from "@/lib/admin-auth-log";
import { readSessionToken, SESSION_COOKIE, sessionEmail } from "@/lib/session";
import { describeUserAgent } from "@/lib/user-agent";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);
  if (!token || !session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mine = sessionIdOf(token);
  await touchSession(mine, clientIp(req), req.headers.get("user-agent"), sessionEmail(session.sub));
  const sessions = (await connectedSessions()).map((s) => ({
    key: s.id.slice(0, 8),
    current: s.id === mine,
    ip: s.ip,
    browser: describeUserAgent(s.userAgent),
    userAgent: s.userAgent,
    via: s.via,
    email: s.email,
    since: s.createdAt,
    lastSeenAt: s.lastSeenAt,
  }));
  return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
}
