import "server-only";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  clientIpOf,
  recordActivity as record,
  sessionIdOf,
  type ActivityContext,
  type ActivityEvent,
} from "@/lib/activity-core.mjs";
import { apiActionProps, pageViewProps } from "@/lib/activity-routes";

/**
 * User activity for genie (page views, actions, terminals, logins): the app's
 * side of activity-core.mjs, which builds and appends the spool lines. Fire and
 * forget — nothing here throws or is worth awaiting.
 */
export function recordActivity(event: ActivityEvent, ctx: ActivityContext = {}): void {
  void record(event, ctx);
}

/** Who sent this request: pass the session cookie only once it has been verified. */
export function activityContext(
  req: Request,
  verifiedToken?: string | null,
): Pick<ActivityContext, "session" | "ip" | "ua"> {
  return {
    session: verifiedToken ? sessionIdOf(verifiedToken) : null,
    ip: clientIpOf(req.headers.get("x-real-ip"), req.headers.get("x-forwarded-for")),
    ua: req.headers.get("user-agent"),
  };
}

// ── Server actions: id → function name ───────────────────────────────────────

// Actions that only read (polled by the UI or opening a dialog): not activity.
const READ_ONLY_ACTIONS = new Set([
  "appStatusesAction",
  "delegateTargetsAction",
  "deployStatusAction",
  "getAgentDefAction",
  "listRunsAction",
  "previewAppPortAction",
  "previewRunAction",
  "runProgressByIdAction",
]);

// A server action arrives as a POST with only its id (Next-Action). The build's
// server-reference-manifest maps ids to exported names; dev writes it under
// <distDir>/dev/server and adds actions as pages compile, so a miss re-reads it.
let manifest: { file: string; mtimeMs: number; names: Map<string, string> } | null = null;

async function loadManifest(): Promise<void> {
  const dist = path.join(process.cwd(), process.env.APP_DIST_DIR ?? ".next");
  const candidates = [
    path.join(dist, "server", "server-reference-manifest.json"),
    path.join(dist, "dev", "server", "server-reference-manifest.json"),
  ];
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const file of candidates) {
    const s = await stat(file).catch(() => null);
    if (s && (!newest || s.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: s.mtimeMs };
  }
  if (!newest || (manifest?.file === newest.file && manifest.mtimeMs === newest.mtimeMs)) return;
  const json = JSON.parse(await readFile(newest.file, "utf8")) as {
    node?: Record<string, { exportedName?: string }>;
  };
  const names = new Map<string, string>();
  for (const [id, entry] of Object.entries(json.node ?? {})) {
    if (entry.exportedName) names.set(id, entry.exportedName);
  }
  manifest = { ...newest, names };
}

/** The action's exported name; null for an id the build doesn't know (Next rejects those). */
async function actionName(id: string): Promise<string | null> {
  if (!manifest?.names.has(id)) await loadManifest().catch(() => {});
  return manifest?.names.get(id) ?? null;
}

// ── From the proxy ───────────────────────────────────────────────────────────

/**
 * What the proxy sees, recorded for signed-in requests (plus the login page):
 *  - a document load of one of our pages → page.view. Client-side navigations
 *    are RSC fetches whose router headers Next strips before the proxy, so they
 *    can't be told from prefetches here; <ActivityBeacon> reports those.
 *  - a server action (Next-Action) → action, by its function name, with the
 *    project of the page it was called from;
 *  - a POST/PUT/PATCH/DELETE to /api/* → action "METHOD /api/route/[pattern]".
 * `path` is basePath-stripped; the query string is never looked at.
 */
export function recordProxyRequest(
  req: Request,
  path: string,
  method: string,
  verifiedToken: string | null,
): void {
  try {
    const ctx = activityContext(req, verifiedToken);
    const actionId = req.headers.get("next-action");
    if (actionId && method === "POST") {
      const page = pageViewProps(path);
      void actionName(actionId)
        .then((name) => {
          if (!name || READ_ONLY_ACTIONS.has(name)) return;
          return record("action", { ...ctx, props: { name, project: page?.project } });
        })
        .catch(() => {});
      return;
    }
    if (path.startsWith("/api/")) {
      const props = apiActionProps(method, path);
      if (props) recordActivity("action", { ...ctx, props });
      return;
    }
    if (method === "GET" && isDocumentLoad(req)) {
      const props = pageViewProps(path);
      if (props) recordActivity("page.view", { ...ctx, props });
    }
  } catch {
    /* never in the way of a request */
  }
}

/** A top-level page load (not an RSC fetch, prefetch, asset or iframe). */
function isDocumentLoad(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  // Browsers without Fetch Metadata (or plain http off localhost): the HTML accept.
  return (req.headers.get("accept") ?? "").includes("text/html");
}
