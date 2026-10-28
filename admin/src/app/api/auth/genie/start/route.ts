import { NextResponse } from "next/server";

import { managerStartUrl, newNonce, NONCE_COOKIE, NONCE_MAX_AGE_S } from "@/lib/genie-sso-core";
import { BASE_PATH, genieIdentity, NONCE_COOKIE_PATH, requestOrigin } from "@/lib/genie-sso";

export const dynamic = "force-dynamic";

/**
 * Sign in with Genie, step 1 (/tmp/sso-contract.md): a fresh nonce in a cookie
 * only the callback gets back, then off to the manager, which signs the person
 * in with Google and posts an assertion carrying the same nonce to the callback.
 * SameSite=None because that post comes from the manager's site.
 */
export async function GET(req: Request) {
  const identity = genieIdentity();
  if (!identity) return NextResponse.json({ error: "not found" }, { status: 404 });

  const nonce = newNonce();
  const returnUrl = `${requestOrigin(req)}${BASE_PATH}/api/auth/genie/callback`;
  const res = NextResponse.redirect(managerStartUrl(identity, nonce, returnUrl), 303);
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: NONCE_COOKIE_PATH,
    maxAge: NONCE_MAX_AGE_S,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
