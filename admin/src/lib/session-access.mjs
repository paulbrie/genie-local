// Whether a session's person may still use the admin: a "user:<email>" session (Sign in with Genie) only while that
// email is on the Users list and enabled, so disabling or removing someone ends their sessions too, not just new
// sign-ins. The shared "admin" session (the emergency password login) always may.
//
// Plain Node ESM (pg only) so the Next side (src/lib/session.ts verifySessionToken: the proxy, requireAdmin…) and the
// custom server (server/pty.mjs: the terminal and board sockets) share it. Answers are cached for a few seconds — on
// globalThis, so the app's and the server's copies of this module (one process) share one cache and one pool — which
// bounds how long a disabled person keeps access without a query on every request.

import pg from "pg";

const USER_PREFIX = "user:";
/** How long an answer stands: a disabled person is out within this. */
export const ACCESS_TTL_MS = 10_000;

const g = /** @type {{ __adminUserAccess?: { cache: Map<string, { ok: boolean, at: number }>, pool: pg.Pool | null, lastError: number } }} */ (globalThis);
const state = (g.__adminUserAccess ??= { cache: new Map(), pool: null, lastError: 0 });

async function lookupEnabled(email) {
  state.pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const { rows } = await state.pool.query("select enabled from admin_users where email = $1", [email]);
  return rows.length > 0 && rows[0].enabled === true;
}

/**
 * True when a verified session's subject may use the admin. `lookup` is for tests. A database error denies (and is
 * logged at most once a minute): the emergency password login still gets in.
 */
export async function subjectAllowed(sub, { lookup = lookupEnabled, now = Date.now() } = {}) {
  if (typeof sub !== "string" || !sub.startsWith(USER_PREFIX)) return true;
  const email = sub.slice(USER_PREFIX.length);
  if (!email) return false;
  const hit = state.cache.get(email);
  if (hit && now - hit.at < ACCESS_TTL_MS) return hit.ok;
  let ok = false;
  try {
    ok = await lookup(email);
  } catch (e) {
    if (now - state.lastError > 60_000) {
      state.lastError = now;
      console.error(`[session-access] couldn't check a user's access: ${e?.message ?? e}`);
    }
    return false; // not cached: the next request asks again
  }
  state.cache.set(email, { ok, at: now });
  return ok;
}

/** Forget a cached answer, so a change on the Users page applies at once (else within ACCESS_TTL_MS). */
export function clearUserAccess(email) {
  if (email) state.cache.delete(String(email).toLowerCase());
  else state.cache.clear();
}
