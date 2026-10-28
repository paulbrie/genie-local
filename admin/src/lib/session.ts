// Signed session-cookie helpers. Uses Web Crypto (HMAC-SHA256), which works in
// both the Node.js runtime (proxy defaults to Node in Next 16) and route
// handlers. Key = APP_ENC_KEY (.env.local).

import { subjectAllowed } from "./session-access.mjs";

const COOKIE_NAME = "admin_session";
const enc = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}

async function getKey(): Promise<CryptoKey> {
  const raw = b64ToBytes(process.env.APP_ENC_KEY ?? "");
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Who a session is: "admin" for the shared password login (and `npm run
 * session`), "user:<email>" for someone who signed in with Genie. Every
 * session, either kind, is a full admin (there are no roles).
 */
export type SessionPayload = { sub: string; exp: number };

const USER_PREFIX = "user:";

export function userSubject(email: string): string {
  return USER_PREFIX + email;
}

/** The person's email for a "user:<email>" subject, null for the shared admin. */
export function sessionEmail(sub: string | null | undefined): string | null {
  return sub?.startsWith(USER_PREFIX) ? sub.slice(USER_PREFIX.length) || null : null;
}

export async function createSessionToken(
  ttlSeconds = SESSION_TTL_SECONDS,
  sub = "admin",
): Promise<string> {
  const payload: SessionPayload = { sub, exp: Date.now() + ttlSeconds * 1000 };
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getKey(), enc.encode(body)),
  );
  return `${body}.${toB64url(sig)}`;
}

/** The payload of a validly signed, unexpired session cookie; null otherwise. */
export async function readSessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: Uint8Array;
  try {
    expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", await getKey(), enc.encode(body)),
    );
  } catch {
    return null;
  }
  let got: Uint8Array;
  try {
    got = fromB64url(sig);
  } catch {
    return null;
  }
  if (expected.length !== got.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (typeof p.exp !== "number" || p.exp <= Date.now()) return null;
    // Cookies from before sessions carried a person were all the shared admin.
    return { sub: typeof p.sub === "string" ? p.sub : "admin", exp: p.exp };
  } catch {
    return null;
  }
}

/**
 * A valid session whose person may still use the admin: signed, unexpired, and
 * for a "user:<email>" session, that email still on the Users list and enabled
 * (session-access.mjs), so disabling someone ends their sessions too. What
 * gates every request (proxy.ts, requireAdmin, isAdminRequest).
 */
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  const session = await readSessionToken(token);
  return session !== null && (await subjectAllowed(session.sub));
}
