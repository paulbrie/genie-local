import { NextResponse, type NextRequest } from "next/server";

import { recordActivity } from "@/lib/activity";
import { clientIp, openSession, recordLoginAttempt, sessionIdOf } from "@/lib/admin-auth-log";
import { accountFor, noteLogin } from "@/lib/admin-users";
import { NONCE_COOKIE, verifyAssertion, type GenieIdentity } from "@/lib/genie-sso-core";
import { BASE_PATH, genieIdentity, jwks, markJtiUsed, NONCE_COOKIE_PATH } from "@/lib/genie-sso";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS, userSubject } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Sign in with Genie, the end (/tmp/sso-contract.md): the manager's page posts
 * `assertion` here, cross-site (the proxy lets exactly this POST past its
 * origin check). The assertion is verified against the manager's keys and the
 * nonce cookie /start set; then the email must be an enabled local account.
 * The browser only ever hears "not allowed" or "failed": why a verification
 * failed goes to the server log, the token never does.
 */
export async function POST(req: NextRequest) {
  const identity = genieIdentity();
  if (!identity) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return await signIn(req, identity);
  } catch (err) {
    // The database (replay store, accounts) being down, say: still a plain "failed".
    console.error("[genie-sso] callback failed:", err instanceof Error ? err.message : err);
    return back(`${BASE_PATH}/login?error=failed`);
  }
}

// Relative Location: the browser resolves it against the origin it is on.
function back(location: string) {
  const res = new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  // The nonce is single use, whatever happens.
  res.cookies.set(NONCE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "none", path: NONCE_COOKIE_PATH, maxAge: 0 });
  return res;
}

async function signIn(req: NextRequest, identity: GenieIdentity) {
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  const nonce = req.cookies.get(NONCE_COOKIE)?.value ?? null;

  const form = await req.formData().catch(() => null);
  const result = await verifyAssertion(form?.get("assertion"), {
    identity,
    nonce,
    keyFor: (kid) => jwks.key(identity.managerUrl, kid),
    markJti: markJtiUsed,
  });

  if (!result.ok) {
    console.warn(`[genie-sso] assertion refused: ${result.reason}`);
    await recordLoginAttempt({ ok: false, reason: "genie_invalid", via: "genie", ip, userAgent });
    recordActivity("auth.failed", { ip, ua: userAgent, props: { reason: "genie_invalid" } });
    return back(`${BASE_PATH}/login?error=failed`);
  }

  const { email } = result.claims;
  const { decision, user } = await accountFor(email);
  if (decision !== "ok" || !user) {
    console.warn(`[genie-sso] refused, account ${decision}`);
    await recordLoginAttempt({ ok: false, reason: "not_allowed", via: "genie", email, ip, userAgent });
    recordActivity("auth.failed", { ip, ua: userAgent, props: { reason: "not_allowed" } });
    return back(`${BASE_PATH}/login?error=not_allowed`);
  }

  const token = await createSessionToken(SESSION_TTL_SECONDS, userSubject(user.email));
  const sessionId = sessionIdOf(token);
  await openSession(sessionId, ip, userAgent, { via: "genie", email: user.email });
  await recordLoginAttempt({ ok: true, via: "genie", email: user.email, ip, userAgent, sessionId });
  await noteLogin(user.id).catch((err) => console.error("[genie-sso] last login:", err instanceof Error ? err.message : err));
  recordActivity("auth.login", { session: sessionId, ip, ua: userAgent, props: { via: "genie" } });

  const res = back(`${BASE_PATH}/`);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
