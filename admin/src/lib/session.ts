// Signed session-cookie helpers. Uses Web Crypto (HMAC-SHA256), which works in
// both the Node.js runtime (proxy defaults to Node in Next 16) and route
// handlers. Key = APP_ENC_KEY (.env.local).

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

export async function createSessionToken(): Promise<string> {
  const payload = { sub: "admin", exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getKey(), enc.encode(body)),
  );
  return `${body}.${toB64url(sig)}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: Uint8Array;
  try {
    expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", await getKey(), enc.encode(body)),
    );
  } catch {
    return false;
  }
  const got = fromB64url(sig);
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return false;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return typeof p.exp === "number" && p.exp > Date.now();
  } catch {
    return false;
  }
}
