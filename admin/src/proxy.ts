import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const PUBLIC_HOSTS = (process.env.APP_PUBLIC_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF: a state-changing request must come from this app's own origin. Browsers
// always send Origin on cross-origin POST/PUT/PATCH/DELETE; requests without it
// (curl, server-side agents) carry no ambient cookie risk.
function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const reqHost = (
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""
  ).toLowerCase();
  return host === reqHost || PUBLIC_HOSTS.includes(host) ||
    PUBLIC_HOSTS.includes(host.replace(/:\d+$/, ""));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Next 16 "Proxy" (the renamed Middleware). Runs before routes render and gates
// the whole app behind a signed session cookie.
//
// NOTE: with basePath '/admin', proxy sees the basePath-STRIPPED path
// (a request to /admin/db arrives here as '/db', /admin as '/').
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  const method = req.method.toUpperCase();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await verifySessionToken(token);

  if (!SAFE_METHODS.has(method) && !originAllowed(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  // Server Actions can be POSTed to ANY page path (incl. /login), so reject
  // them up front when there's no session. Each action also calls
  // requireAdmin() as defense in depth.
  if (req.headers.has("next-action") && !authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Framework assets + HMR: always allowed. Anchored on purpose — a substring
  // match would let /api/foo/_next/... skip auth.
  if (path.startsWith("/_next/") || path === "/favicon.ico") {
    return NextResponse.next();
  }
  // Login page (GET only) + auth endpoints: allowed unauthenticated.
  if (path === "/login" && SAFE_METHODS.has(method)) {
    return NextResponse.next();
  }
  if (path === "/api/login" || path === "/api/logout") {
    return NextResponse.next();
  }

  if (authed) {
    return NextResponse.next();
  }

  // Agent path: the diagrams API accepts a shared key so a server-side agent can
  // create/update diagrams without a browser session. Only enabled when
  // DIAGRAMS_API_KEY is set; the header is compared in constant time.
  const apiKey = process.env.DIAGRAMS_API_KEY;
  if (
    apiKey &&
    path.startsWith("/api/diagrams") &&
    timingSafeEqual(req.headers.get("x-api-key") ?? "", apiKey)
  ) {
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
