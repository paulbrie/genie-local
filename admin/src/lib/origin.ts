// CSRF origin check, shared by the proxy (every state-changing request) and the
// login route (which checks it itself so a rejected login is logged with why).

const PUBLIC_HOSTS = (process.env.APP_PUBLIC_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * A state-changing request must come from this app's own origin. Browsers
 * always send Origin on cross-origin POST/PUT/PATCH/DELETE; requests without it
 * (curl, server-side agents) carry no ambient cookie risk.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const reqHost = (
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""
  ).toLowerCase();
  return (
    host === reqHost ||
    PUBLIC_HOSTS.includes(host) ||
    PUBLIC_HOSTS.includes(host.replace(/:\d+$/, ""))
  );
}
