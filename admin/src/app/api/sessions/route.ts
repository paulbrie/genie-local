// GET: the top bar's heartbeat. Marks this browser's session as seen now and
// returns the sessions connected right now (a tab open in the last minute).
import { NextRequest, NextResponse } from "next/server";

import {
  clientIp,
  connectedSessions,
  sessionIdOf,
  touchSession,
} from "@/lib/admin-auth-log";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { describeUserAgent } from "@/lib/user-agent";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mine = sessionIdOf(token);
  await touchSession(mine, clientIp(req), req.headers.get("user-agent"));
  const sessions = (await connectedSessions()).map((s) => ({
    key: s.id.slice(0, 8),
    current: s.id === mine,
    ip: s.ip,
    browser: describeUserAgent(s.userAgent),
    userAgent: s.userAgent,
    via: s.via,
    since: s.createdAt,
    lastSeenAt: s.lastSeenAt,
  }));
  return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
}
