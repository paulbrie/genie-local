import { NextResponse } from "next/server";

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

function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILS) {
    return NextResponse.json(
      { ok: false, error: "Too many failed attempts — try again later" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) },
      },
    );
  }

  const { username, password } = await req.json().catch(() => ({}));
  const ok =
    typeof username === "string" &&
    typeof password === "string" &&
    !!PASS &&
    constantTimeEqual(username, USER) &&
    constantTimeEqual(password, PASS);

  if (!ok) {
    if (!entry || entry.resetAt <= now) {
      failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count++;
    }
    if (failures.size > 10_000) {
      for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
    }
    return NextResponse.json(
      { ok: false, error: "Invalid username or password" },
      { status: 401 },
    );
  }

  failures.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    // Public origin is https (TLS terminates at nginx, which sets this header).
    secure: req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
