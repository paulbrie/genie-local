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

  // API → 401 JSON; pages → redirect to the login page (full public path).
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/admin/login", req.url);
  if (path !== "/") loginUrl.searchParams.set("next", path); // basePath-relative
  return NextResponse.redirect(loginUrl);
}
