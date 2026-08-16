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

export async function POST(req: Request) {
  const { username, password } = await req.json().catch(() => ({}));
  const ok =
    typeof username === "string" &&
    typeof password === "string" &&
    !!PASS &&
    constantTimeEqual(username, USER) &&
    constantTimeEqual(password, PASS);

  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "Invalid username or password" },
      { status: 401 },
    );
  }

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
