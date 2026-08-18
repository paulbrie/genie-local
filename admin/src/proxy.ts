import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Next 16 "Proxy" (the renamed Middleware). Runs before routes render and gates
// the whole app behind a signed session cookie.
//
// NOTE: with basePath '/admin', proxy sees the basePath-STRIPPED path
// (a request to /admin/db arrives here as '/db', /admin as '/').
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Framework assets + HMR: always allowed.
  if (path.includes("/_next/") || path.endsWith("/favicon.ico")) {
    return NextResponse.next();
  }
  // Login page + auth endpoints: allowed unauthenticated.
  if (path === "/login" || path === "/api/login" || path === "/api/logout") {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  // API → 401 JSON; pages → redirect to this instance's login page.
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Resolve the login URL against the CURRENT request's origin (req.url) rather
  // than a hardcoded host, so the redirect stays on whatever domain the user is
  // on. Use this instance's basePath so the dev instance lands on
  // /admin-dev/login, not prod's /admin/login (basePath is per-instance env).
  // `path` is basePath-stripped.
  const basePath = process.env.APP_BASE_PATH ?? "/admin";
  const loginUrl = new URL(`${basePath}/login`, req.url);
  if (path !== "/") loginUrl.searchParams.set("next", path);
  return NextResponse.redirect(loginUrl);
}
