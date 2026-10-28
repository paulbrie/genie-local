/**
 * User activity → genie: the one place a spool line is built and written. Plain
 * ESM with no dependencies, because two runtimes write events:
 *
 *  - the Next app (`src/lib/activity.ts`: page views and actions from the proxy,
 *    logins and logouts from their routes);
 *  - the raw-Node custom server (`server/pty.mjs`: terminal attach / detach).
 *
 * The genie-stats daemon ships the spool (/tmp/activity-contract.md §1): one JSON
 * object per line, only ever appended, one `appendFile` per event opened by path,
 * so the daemon can rename the file away at any moment. Over 50 MB, events are
 * dropped until it has been shipped.
 *
 * What a line may hold is deliberately narrow: each event has its own allowlist
 * of props, each prop its own shape check (a route pattern, a slug, a function
 * name…), so contents (terminal I/O, SQL, prompts, file data, query strings,
 * request bodies, usernames, secrets) have nowhere to go. The IP is only kept as
 * a keyed hash, the user agent as "<browser> on <OS>".
 *
 * Writing must never break or slow what it records: `recordActivity` never
 * throws and its promise never rejects; callers don't await it.
 *
 * Types live in activity-core.d.mts.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const LINE_VERSION = 1;
export const DEFAULT_SPOOL = "/opt/project/.activity/activity.jsonl";
export const SPOOL_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_PROPS = 12;
export const MAX_STRING = 200;
const MAX_UA = 60;

export function spoolPath() {
  return process.env.ACTIVITY_SPOOL || DEFAULT_SPOOL;
}

// ── Who ──────────────────────────────────────────────────────────────────────

/** A session's id: a hash of its cookie (never stored itself) — admin_sessions.id. */
export function sessionIdOf(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** The client's IP as nginx passes it on (X-Real-IP, else the first X-Forwarded-For). */
export function clientIpOf(realIp, forwardedFor) {
  return realIp ?? forwardedFor?.split(",")[0]?.trim() ?? null;
}

// The IP key is derived from APP_ENC_KEY rather than being it, so the hash says
// nothing about the key that signs sessions.
let ipKey = { from: null, key: null };
function ipKeyFor(appEncKey) {
  if (ipKey.from !== appEncKey) {
    ipKey = {
      from: appEncKey,
      key: createHmac("sha256", Buffer.from(appEncKey, "base64")).update("activity-ip").digest(),
    };
  }
  return ipKey.key;
}

/** HMAC-SHA256 of the IP under the derived key, first 16 hex; null without an IP or a key. */
export function hashIp(ip, appEncKey = process.env.APP_ENC_KEY) {
  if (!ip || ip === "unknown" || !appEncKey) return null;
  return createHmac("sha256", ipKeyFor(appEncKey)).update(ip).digest("hex").slice(0, 16);
}

/**
 * "Chrome on Linux": browser family and OS only, null when neither is known.
 * Unlike describeUserAgent (user-agent.ts) no versions and never the raw string.
 */
export function uaFamily(ua) {
  if (!ua || typeof ua !== "string") return null;
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\bOPR\//.test(ua)
      ? "Opera"
      : /\b(Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /\bHeadlessChrome\//.test(ua)
          ? "Headless Chrome"
          : /\b(Chrome|CriOS|Chromium)\//.test(ua)
            ? "Chrome"
            : /\bVersion\/[\d.]+.*\bSafari\//.test(ua)
              ? "Safari"
              : /^curl\//.test(ua)
                ? "curl"
                : /^node|undici/i.test(ua)
                  ? "Node.js script"
                  : null;
  const os = /\bWindows\b/.test(ua)
    ? "Windows"
    : /\bAndroid\b/.test(ua)
      ? "Android"
      : /\b(iPhone|iPad|iPod)\b/.test(ua)
        ? "iOS"
        : /\bCrOS\b/.test(ua)
          ? "ChromeOS"
          : /\b(Macintosh|Mac OS X)\b/.test(ua)
            ? "macOS"
            : /\bLinux\b/.test(ua)
              ? "Linux"
              : null;
  const out = browser && os ? `${browser} on ${os}` : (browser ?? (os ? `Other on ${os}` : null));
  return out ? out.slice(0, MAX_UA) : null;
}

// ── What ─────────────────────────────────────────────────────────────────────

const isPattern = (v) => typeof v === "string" && /^\/[A-Za-z0-9_.\-[\]/]*$/.test(v);
const isSlug = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v);
const isActionName = (v) =>
  typeof v === "string" &&
  (/^[A-Za-z_$][\w$]{0,99}$/.test(v) || /^(POST|PUT|PATCH|DELETE) \/api(\/[A-Za-z0-9_.\-[\]]+)*$/.test(v));
// Mirrors toTarget in server/pty.mjs: a tmux session name, never anything typed into it.
const isTerminal = (v) => typeof v === "string" && v.length > 0 && v.length <= 64 && !/[\x00-\x1f\x7f]/.test(v);
const isSeconds = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isBool = (v) => typeof v === "boolean";
const isReason = (v) => typeof v === "string" && /^[a-z_]{1,40}$/.test(v);
// How someone signed in: Sign in with Genie or the shared (emergency) password login.
const isLoginVia = (v) => v === "genie" || v === "password";

/** The events the receiver accepts, each with the props it may carry and their shape. */
export const EVENT_PROPS = {
  "page.view": { path: isPattern, project: isSlug },
  action: { name: isActionName, project: isSlug, ok: isBool },
  "terminal.attach": { terminal: isTerminal },
  "terminal.detach": { terminal: isTerminal, seconds: isSeconds },
  "auth.login": { via: isLoginVia },
  "auth.logout": {},
  "auth.failed": { reason: isReason },
};

export function isActivityEvent(event) {
  return typeof event === "string" && Object.hasOwn(EVENT_PROPS, event);
}

/**
 * The generic limits: at most 12 keys, values only string (≤200 chars, cut),
 * finite number, boolean or null. Anything else (objects, arrays, functions…)
 * is dropped, never stringified.
 */
export function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(props)) {
    if (n >= MAX_PROPS) break;
    let v;
    if (value === null || typeof value === "boolean") v = value;
    else if (typeof value === "number") v = Number.isFinite(value) ? value : undefined;
    else if (typeof value === "string") v = value.slice(0, MAX_STRING);
    if (v === undefined) continue;
    out[key] = v;
    n++;
  }
  return out;
}

/** sanitizeProps, then only the event's own keys whose value has the right shape. */
export function propsFor(event, props) {
  const allowed = EVENT_PROPS[event];
  const out = {};
  if (!allowed) return out;
  for (const [key, value] of Object.entries(sanitizeProps(props))) {
    if (!Object.hasOwn(allowed, key) || !allowed[key](value)) continue;
    out[key] = key === "seconds" ? Math.round(value) : value;
  }
  return out;
}

/** One spool line (with its newline), or null for an event outside the allowlist. */
export function buildLine(event, { session = null, ip = null, ua = null, props } = {}, now = Date.now()) {
  if (!isActivityEvent(event)) return null;
  return (
    JSON.stringify({
      v: LINE_VERSION,
      id: randomUUID(),
      ts: now,
      event,
      session: typeof session === "string" && /^[0-9a-f]{32}$/.test(session) ? session : null,
      ipHash: hashIp(ip),
      ua: uaFamily(ua),
      props: propsFor(event, props),
    }) + "\n"
  );
}

// ── Where ────────────────────────────────────────────────────────────────────

let lastReport = 0;
function report(err) {
  // At most one line a minute: a full disk shouldn't also flood the journal.
  if (Date.now() - lastReport < 60_000) return;
  lastReport = Date.now();
  console.error("[activity]", err instanceof Error ? err.message : err);
}

/** Append one line unless the spool is over the cap. Resolves true when written. */
export async function appendLine(line, file = spoolPath()) {
  try {
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    if (size > SPOOL_MAX_BYTES) return false;
    try {
      await appendFile(file, line, { mode: 0o600 });
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, line, { mode: 0o600 });
    }
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

/**
 * Record one event: `session` is the admin session id (sessionIdOf), `ip` and
 * `ua` the raw client IP and User-Agent header (hashed and reduced here).
 * Never throws; resolves true when the line was written.
 */
export function recordActivity(event, ctx = {}, file = spoolPath()) {
  try {
    const line = buildLine(event, ctx);
    if (!line) {
      report(`unknown event ${String(event).slice(0, 40)}`);
      return Promise.resolve(false);
    }
    return appendLine(line, file);
  } catch (err) {
    report(err);
    return Promise.resolve(false);
  }
}
