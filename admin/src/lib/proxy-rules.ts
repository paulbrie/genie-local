// What the proxy (src/proxy.ts) lets through without a session or past its
// CSRF origin check. Pure, so proxy-rules.test.ts pins it down. Paths are
// basePath-stripped, as the proxy sees them.

export const GENIE_CALLBACK = "/api/auth/genie/callback";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requests the origin check doesn't block: /api/login checks the origin itself
 * (so a blocked login is logged with why), and the Sign in with Genie callback
 * is a cross-site form POST from the manager by design, protected instead by
 * the assertion's signature and the nonce cookie. Only POST, only that route.
 */
export function skipsOriginCheck(path: string, method: string): boolean {
  return path === "/api/login" || (path === GENIE_CALLBACK && method.toUpperCase() === "POST");
}

/** Reachable signed out: the login page (GET), the login / logout routes and Sign in with Genie. */
export function isPublicPath(path: string, method: string): boolean {
  if (path === "/login") return SAFE_METHODS.has(method.toUpperCase());
  return path === "/api/login" || path === "/api/logout" || path.startsWith("/api/auth/genie/");
}
