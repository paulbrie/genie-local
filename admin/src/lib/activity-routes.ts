// Concrete paths → their app-router patterns, for activity events: a page view
// records `/projects/[slug]/files`, never `/projects/genie-brand/files`, and the
// slug goes in its own `project` prop. Kept as a table (not read from the build)
// so the proxy needs no fs; activity-routes.test.ts walks src/app and fails when
// a page or route is added without its line here.

/** Every page.tsx under src/app, as its route. */
export const PAGE_ROUTES = [
  "/",
  "/agents",
  "/agents3d",
  "/boards",
  "/boards/[id]",
  "/chrome",
  "/claude",
  "/comms",
  "/db",
  "/diagrams",
  "/docker",
  "/files",
  "/firewall",
  "/login",
  "/logins",
  "/logs",
  "/nginx",
  "/processes",
  "/projects",
  "/projects/[slug]",
  "/projects/[slug]/files",
  "/projects/[slug]/git",
  "/projects/[slug]/git/[hash]",
  "/projects/[slug]/memory",
  "/projects/[slug]/notes",
  "/projects/[slug]/scripts",
  "/projects/[slug]/tasks",
  "/railway",
  "/recipes",
  "/services",
  "/tasks",
  "/teams",
  "/terminals",
  "/users",
] as const;

/** Every route.ts under src/app/api, as its route. */
export const API_ROUTES = [
  "/api/activity",
  "/api/admin-update",
  "/api/agents3d",
  "/api/agents3d/browsers",
  "/api/agents3d/file",
  "/api/agents3d/panes",
  "/api/ask",
  "/api/auth/genie/callback",
  "/api/auth/genie/start",
  "/api/authcheck",
  "/api/boards",
  "/api/boards/[id]",
  "/api/boards/[id]/assets",
  "/api/boards/[id]/history",
  "/api/boards/[id]/ops",
  "/api/boards/assets/[board]/[file]",
  "/api/chrome",
  "/api/chrome/kill",
  "/api/chrome/pages",
  "/api/chrome/screenshot",
  "/api/claude/comms",
  "/api/claude/logs",
  "/api/claude/logs/tail",
  "/api/claude/memories",
  "/api/claude/memories/read",
  "/api/claude/sessions",
  "/api/claude/sessions/transcript",
  "/api/code-review",
  "/api/db/[id]/databases",
  "/api/db/[id]/queries",
  "/api/db/[id]/query",
  "/api/db/[id]/rows",
  "/api/db/[id]/tables",
  "/api/db/[id]/test",
  "/api/db/connections",
  "/api/db/connections/[id]",
  "/api/db/queries/[qid]",
  "/api/diagrams",
  "/api/diagrams/[id]",
  "/api/diagrams/validate",
  "/api/disk-usage",
  "/api/docker",
  "/api/docker/action",
  "/api/docker/logs",
  "/api/docker/stats",
  "/api/files",
  "/api/files/archive",
  "/api/files/raw",
  "/api/files/upload",
  "/api/files/upload/[id]",
  "/api/firewall",
  "/api/firewall/allowlist",
  "/api/firewall/toggle",
  "/api/git",
  "/api/git/checkout",
  "/api/git/commit",
  "/api/git/diff",
  "/api/git/fetch",
  "/api/git/merge",
  "/api/git/push",
  "/api/git/worktrees",
  "/api/login",
  "/api/logout",
  "/api/logs",
  "/api/logs/tail",
  "/api/narrate",
  "/api/nginx",
  "/api/nginx/file",
  "/api/processes",
  "/api/processes/kill",
  "/api/project-memory",
  "/api/project-memory/history",
  "/api/projects",
  "/api/projects/[slug]/scripts",
  "/api/projects/[slug]/tasks",
  "/api/projects/[slug]/tasks/[taskId]/attachments",
  "/api/projects/[slug]/tasks/events",
  "/api/railway/deployments",
  "/api/railway/logs",
  "/api/railway/projects",
  "/api/run-status",
  "/api/scan",
  "/api/services",
  "/api/services/action",
  "/api/services/logs",
  "/api/sessions",
  "/api/stats",
  "/api/stats/history",
  "/api/task-attachments/[id]",
  "/api/team/tasks",
  "/api/teams",
  "/api/terminals",
  "/api/terminals/[name]",
  "/api/terminals/[name]/image",
  "/api/tts",
] as const;

/**
 * Mutating /api calls that aren't someone doing something: the login routes
 * (auth.* events instead), the page-view beacon, and what the UI fires on its
 * own (Jarvis narration, speech, the diagram editor's live validation).
 */
const NOT_ACTIONS = new Set([
  "/api/activity",
  "/api/auth/genie/callback",
  "/api/login",
  "/api/logout",
  "/api/narrate",
  "/api/tts",
  "/api/diagrams/validate",
]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Compiled = { pattern: string; parts: string[]; rank: number[] };

// Static segments beat dynamic ones beat catch-alls, left to right, so
// /api/boards/assets/x/y is the assets route and not /api/boards/[id]/….
function compile(routes: readonly string[]): Compiled[] {
  return routes
    .map((pattern) => {
      const parts = pattern.split("/").filter(Boolean);
      const rank = parts.map((p) => (p.startsWith("[...") || p.startsWith("[[...") ? 2 : p.startsWith("[") ? 1 : 0));
      return { pattern, parts, rank };
    })
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
        const d = (a.rank[i] ?? -1) - (b.rank[i] ?? -1);
        if (d) return d;
      }
      return 0;
    });
}

const PAGES = compile(PAGE_ROUTES);
const APIS = compile(API_ROUTES);

export type RouteMatch = { pattern: string; params: Record<string, string> };

function match(path: string, table: Compiled[]): RouteMatch | null {
  let segs: string[];
  try {
    segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // malformed %-escape
  }
  for (const r of table) {
    const params: Record<string, string> = {};
    let ok = true;
    let i = 0;
    for (; i < r.parts.length; i++) {
      const p = r.parts[i];
      const optional = p.startsWith("[[...");
      if (p.startsWith("[...") || optional) {
        if (!optional && i >= segs.length) ok = false;
        else params[p.replace(/^\[+\.\.\.|\]+$/g, "")] = segs.slice(i).join("/");
        i = segs.length;
        break;
      }
      if (i >= segs.length) {
        ok = false;
        break;
      }
      if (p.startsWith("[")) params[p.slice(1, -1)] = segs[i];
      else if (p !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok && i === segs.length) return { pattern: r.pattern, params };
  }
  return null;
}

/** A page's pattern for a basePath-stripped pathname (no query), null if it isn't a page. */
export function matchPage(path: string): RouteMatch | null {
  return match(path, PAGES);
}

export function matchApi(path: string): RouteMatch | null {
  return match(path, APIS);
}

/** Props of a page.view for this pathname, null when it is no page of ours. */
export function pageViewProps(path: string): { path: string; project?: string } | null {
  const m = matchPage(path);
  if (!m) return null;
  return m.params.slug !== undefined && m.pattern.startsWith("/projects/[slug]")
    ? { path: m.pattern, project: m.params.slug }
    : { path: m.pattern };
}

/** Props of an action for a mutating /api request, null when it isn't one we record. */
export function apiActionProps(
  method: string,
  path: string,
): { name: string; project?: string } | null {
  const verb = method.toUpperCase();
  if (!MUTATING.has(verb)) return null;
  const m = matchApi(path);
  if (!m || NOT_ACTIONS.has(m.pattern)) return null;
  const name = `${verb} ${m.pattern}`;
  return m.params.slug !== undefined && m.pattern.startsWith("/api/projects/[slug]")
    ? { name, project: m.params.slug }
    : { name };
}
