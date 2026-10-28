// Sign in with Genie (/tmp/sso-contract.md), the parts that need no framework:
// the server's identity, the JWKS cache, verifying the manager's assertion and
// matching its email to a local account. node:crypto only, so the tests run it
// as is; the routes and the database live in genie-sso.ts / admin-users.ts.
import { createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** Written by the genie manager (non-secret: no token in it). */
export const GENIE_INSTANCE_FILE = "/opt/project/.genie-instance.json";

export const NONCE_COOKIE = "genie_sso_nonce";
export const NONCE_MAX_AGE_S = 600;
export const CLOCK_SKEW_S = 60;
export const JWKS_TTL_MS = 5 * 60_000;
// A token with an unknown kid makes us refetch the JWKS, at most this often, so
// posting made-up kids can't turn this server into a pump against the manager.
export const JWKS_MIN_REFETCH_MS = 10_000;
// The manager issues them for 120 s; anything meant to live longer isn't its.
const MAX_LIFETIME_S = 600;

// ── Identity ─────────────────────────────────────────────────────────────────

export type GenieIdentity = {
  managerUrl: string;
  projectId: string;
  instanceId: string;
  publicOrigin: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The identity from the file's text (null when there is none) with env
 * GENIE_MANAGER_URL / GENIE_PROJECT_ID / GENIE_INSTANCE_ID overriding it field
 * by field. Null unless all three are there and the manager URL is http(s).
 */
export function parseGenieIdentity(
  fileText: string | null,
  env: Record<string, string | undefined> = process.env,
): GenieIdentity | null {
  let file: Record<string, unknown> = {};
  if (fileText) {
    try {
      const parsed = JSON.parse(fileText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {
      /* unreadable: as if absent (env may still configure it) */
    }
  }
  const managerUrl = str(env.GENIE_MANAGER_URL) ?? str(file.managerUrl);
  const projectId = str(env.GENIE_PROJECT_ID) ?? str(file.projectId);
  const instanceId = str(env.GENIE_INSTANCE_ID) ?? str(file.instanceId);
  if (!managerUrl || !projectId || !instanceId) return null;
  let url: URL;
  try {
    url = new URL(managerUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return {
    managerUrl: managerUrl.replace(/\/+$/, ""),
    projectId,
    instanceId,
    publicOrigin: str(file.publicOrigin),
  };
}

/** Read fresh each time (a few bytes), so the manager writing it needs no restart. */
export function readGenieIdentity(file = GENIE_INSTANCE_FILE): GenieIdentity | null {
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    /* not there: not configured unless the env says so */
  }
  return parseGenieIdentity(text, process.env);
}

export const audienceOf = (identity: GenieIdentity) => `genie-vps:${identity.instanceId}`;

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Where /start sends the browser: the manager's sign-in for this server. */
export function managerStartUrl(identity: GenieIdentity, nonce: string, returnUrl: string): string {
  const q = new URLSearchParams({
    project: identity.projectId,
    instance: identity.instanceId,
    nonce,
    return: returnUrl,
  });
  return `${identity.managerUrl}/auth/vps/start?${q}`;
}

// ── JWKS ─────────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type JwksEntry = { keys: Map<string, KeyObject>; fetchedAt: number; triedAt: number };

/** Only Ed25519 signing keys; anything else in the set is skipped. */
export function parseJwks(json: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  const keys = (json as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return out;
  for (const k of keys) {
    if (!k || typeof k !== "object") continue;
    const { kty, crv, x, kid, alg, use } = k as Record<string, unknown>;
    if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof kid !== "string" || !kid) continue;
    if (alg !== undefined && alg !== "EdDSA") continue;
    if (use !== undefined && use !== "sig") continue;
    try {
      out.set(kid, createPublicKey({ key: { kty, crv, x }, format: "jwk" }));
    } catch {
      /* not a valid key */
    }
  }
  return out;
}

/**
 * The manager's public keys, per manager URL: fetched on first need, kept 5
 * min, refetched once for a kid it doesn't know (throttled). A failed fetch
 * keeps the keys it had.
 */
export function createJwksCache({
  fetchImpl = (url, init) => fetch(url, init),
  now = Date.now,
  ttlMs = JWKS_TTL_MS,
  minRefetchMs = JWKS_MIN_REFETCH_MS,
}: { fetchImpl?: FetchLike; now?: () => number; ttlMs?: number; minRefetchMs?: number } = {}) {
  const entries = new Map<string, JwksEntry>();
  const inflight = new Map<string, Promise<void>>();

  const refresh = (managerUrl: string) => {
    const running = inflight.get(managerUrl);
    if (running) return running;
    const p = (async () => {
      const entry = entries.get(managerUrl);
      if (entry) entry.triedAt = now();
      try {
        const res = await fetchImpl(`${managerUrl}/api/vps/sso/jwks`, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        const keys = parseJwks(await res.json());
        if (keys.size === 0) throw new Error("JWKS has no Ed25519 keys");
        entries.set(managerUrl, { keys, fetchedAt: now(), triedAt: now() });
      } catch (err) {
        console.error("[genie-sso] JWKS fetch failed:", err instanceof Error ? err.message : err);
        if (!entry) entries.set(managerUrl, { keys: new Map(), fetchedAt: 0, triedAt: now() });
      }
    })().finally(() => inflight.delete(managerUrl));
    inflight.set(managerUrl, p);
    return p;
  };

  return {
    async key(managerUrl: string, kid: string): Promise<KeyObject | null> {
      let entry = entries.get(managerUrl);
      const stale = !entry || now() - entry.fetchedAt >= ttlMs;
      const mayRetry = !entry || now() - entry.triedAt >= minRefetchMs;
      if (mayRetry && (stale || !entry?.keys.has(kid))) {
        await refresh(managerUrl);
        entry = entries.get(managerUrl);
      }
      return entry?.keys.get(kid) ?? null;
    },
    clear() {
      entries.clear();
    },
  };
}

// ── The assertion ────────────────────────────────────────────────────────────

export type AssertionFailure =
  | "malformed"
  | "bad_header"
  | "unknown_kid"
  | "bad_signature"
  | "bad_iss"
  | "bad_aud"
  | "bad_project"
  | "bad_nonce"
  | "expired"
  | "future_iat"
  | "bad_lifetime"
  | "bad_claims"
  | "replayed";

export type AssertionClaims = { sub: string; email: string; name: string | null; jti: string };

export type VerifyOptions = {
  identity: GenieIdentity;
  /** The nonce cookie's value (null when the browser sent none). */
  nonce: string | null | undefined;
  keyFor: (kid: string) => Promise<KeyObject | null>;
  /** Records a jti until `expiresAtMs`; resolves false when it was already used. */
  markJti: (jti: string, expiresAtMs: number) => Promise<boolean>;
  now?: number;
};

const B64URL = /^[A-Za-z0-9_-]*$/;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Every check the contract lists, in this order: shape, kid, EdDSA signature,
 * iss, aud, project, nonce, exp / iat (60 s skew), the claims, and last the
 * jti (so a token refused for anything else doesn't use up its jti).
 */
export async function verifyAssertion(
  token: unknown,
  opts: VerifyOptions,
): Promise<{ ok: true; claims: AssertionClaims } | { ok: false; reason: AssertionFailure }> {
  const fail = (reason: AssertionFailure) => ({ ok: false as const, reason });
  if (typeof token !== "string" || token.length > 8192) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => p && B64URL.test(p))) return fail("malformed");

  const header = decodeJson(parts[0]);
  if (!header || header.alg !== "EdDSA" || (header.typ !== undefined && header.typ !== "JWT")) {
    return fail("bad_header");
  }
  const kid = header.kid;
  if (typeof kid !== "string" || !kid || kid.length > 200) return fail("bad_header");

  const key = await opts.keyFor(kid);
  if (!key) return fail("unknown_kid");
  const sig = Buffer.from(parts[2], "base64url");
  let good = false;
  try {
    good = sig.length === 64 && verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, sig);
  } catch {
    good = false;
  }
  if (!good) return fail("bad_signature");

  const c = decodeJson(parts[1]);
  if (!c) return fail("malformed");
  const { identity } = opts;
  if (typeof c.iss !== "string" || c.iss.replace(/\/+$/, "") !== identity.managerUrl) return fail("bad_iss");
  const aud = audienceOf(identity);
  if (!(c.aud === aud || (Array.isArray(c.aud) && c.aud.includes(aud)))) return fail("bad_aud");
  if (c.project !== identity.projectId) return fail("bad_project");
  if (!opts.nonce || typeof c.nonce !== "string" || !sameString(c.nonce, opts.nonce)) return fail("bad_nonce");

  const now = (opts.now ?? Date.now()) / 1000;
  const { exp, iat } = c;
  if (typeof exp !== "number" || typeof iat !== "number" || !Number.isFinite(exp) || !Number.isFinite(iat)) {
    return fail("bad_claims");
  }
  if (exp + CLOCK_SKEW_S <= now) return fail("expired");
  if (iat > now + CLOCK_SKEW_S) return fail("future_iat");
  if (exp <= iat || exp - iat > MAX_LIFETIME_S) return fail("bad_lifetime");

  const email = typeof c.email === "string" ? normalizeEmail(c.email) : "";
  const { sub, jti } = c;
  if (typeof sub !== "string" || !sub || !isEmail(email)) return fail("bad_claims");
  if (typeof jti !== "string" || !jti || jti.length > 200) return fail("bad_claims");
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 200) : null;

  if (!(await opts.markJti(jti, (exp + CLOCK_SKEW_S) * 1000))) return fail("replayed");
  return { ok: true, claims: { sub, email, name, jti } };
}

// ── Local accounts ───────────────────────────────────────────────────────────

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type AccountDecision = "ok" | "absent" | "disabled";

/** Whether this email may sign in, given the accounts (stored lowercased). */
export function accountDecision(
  rows: readonly { email: string; enabled: boolean }[],
  email: string,
): AccountDecision {
  const row = rows.find((r) => r.email === normalizeEmail(email));
  return !row ? "absent" : row.enabled ? "ok" : "disabled";
}
