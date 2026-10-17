import { NextResponse } from "next/server";

import {
  clientIp,
  openSession,
  recordLoginAttempt,
  sessionIdOf,
  type LoginFailure,
} from "@/lib/admin-auth-log";
import { originAllowed } from "@/lib/origin";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/session";

export const dynamic = "force-dynamic";

const USER = process.env.ADMIN_USER ?? "admin";
const PASS = process.env.ADMIN_PASSWORD ?? "";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Brute-force throttle: per client IP, at most MAX_FAILS failures per window.
// In-memory is enough for a single-process admin. nginx sets X-Real-IP.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

/**
 * Every attempt lands in the login log (Logins page) with its reason; the
 * browser still only hears "Invalid username or password", so the reply
 * doesn't tell a guesser which half was right.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  const now = Date.now();

  const fail = async (
    reason: LoginFailure,
    username: string | null,
    body: { status: number; error: string; headers?: Record<string, string> },
  ) => {
    await recordLoginAttempt({ ok: false, reason, username, ip, userAgent });
    return NextResponse.json(
      { ok: false, error: body.error },
      { status: body.status, headers: body.headers },
    );
  };

  // The proxy lets /api/login through so a blocked origin is logged here.
  if (!originAllowed(req)) {
    return fail("forbidden_origin", null, { status: 403, error: "forbidden origin" });
  }

  const entry = failures.get(ip);
  const { username, password } = await req.json().catch(() => ({}));
  const typedUser = typeof username === "string" ? username : null;

  if (entry && entry.resetAt > now && entry.count >= MAX_FAILS) {
    return fail("rate_limited", typedUser, {
      status: 429,
      error: "Too many failed attempts — try again later",
      headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) },
    });
  }

  const reason: LoginFailure | null =
    typeof username !== "string" || typeof password !== "string" || !username || !password
      ? "bad_request"
      : !PASS
        ? "not_configured"
        : !constantTimeEqual(username, USER)
          ? "unknown_user"
          : !constantTimeEqual(password, PASS)
            ? "wrong_password"
            : null;

  if (reason) {
    if (!entry || entry.resetAt <= now) {
      failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count++;
    }
    if (failures.size > 10_000) {
      for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
    }
    return fail(reason, typedUser, { status: 401, error: "Invalid username or password" });
  }

  failures.delete(ip);
  const token = await createSessionToken();
  const sessionId = sessionIdOf(token);
  await openSession(sessionId, ip, userAgent);
  await recordLoginAttempt({ ok: true, username: typedUser, ip, userAgent, sessionId });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    // Public origin is https (TLS terminates at nginx, which sets this header).
    secure: req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
