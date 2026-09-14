import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Lightweight auth probe for nginx `auth_request` — used to gate /vscode
// (code-server) behind the SAME admin session cookie as the rest of /admin.
// Returns 200 when the request carries a valid `admin_session` cookie, 401
// otherwise. No body, no side effects. (src/proxy.ts already 401s unauthed
// /api/* requests before they reach here; the in-route check is a safety net.)
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifySessionToken(token);
  return new NextResponse(null, { status: ok ? 200 : 401 });
}
