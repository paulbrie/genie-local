import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects } from "@/db/schema";
import {
  DEFAULT_PORT_POLICY, applyWithRollback, diffLines, expandIncludes, extractRoutes, findProblems, parseNginx, parseSsListeners,
  portChangeConflicts, renderProjectsConfText, type AppRow, type ConfRow, type Conflict, type DiffLine, type ListenerInfo,
  type PortPolicy, type Problem, type Route, type ServerInfo,
} from "@/lib/nginx-routes";
import { isAppServerRunning } from "@/lib/run-slug";
import { listRunningSlugs } from "@/lib/runner";
import { PROJECTS_ROOT } from "@/lib/signals";

const execFileAsync = promisify(execFile);

/** Genie-owned file that the main Nginx server block `include`s. */
const PROJECTS_CONF_PATH =
  process.env.NGINX_PROJECTS_CONF ?? "/opt/project/admin/nginx/projects.conf";
/** Root-owned helper genie may run passwordless (only `nginx -t && reload`). */
const RELOAD_CMD =
  process.env.NGINX_RELOAD_CMD ?? "/usr/local/bin/ft-nginx-reload";

/**
 * Public mount path for an app. A project with a single app mounts at the
 * project root (`/projects/<project>`); otherwise each app gets its own segment
 * (`/projects/<project>/<app>`). The app's Next `basePath` must equal this.
 */
export function mountPath(
  proj: string,
  app: string,
  singleApp: boolean,
): string {
  return app === "" || singleApp
    ? `/projects/${proj}`
    : `/projects/${proj}/${app}`;
}

/** Every app with its port and mount path (and an id), in the include's order. */
async function appConfRows(): Promise<(ConfRow & { appId: number })[]> {
  // All apps (to know per-project counts), plus ports for routing.
  const rows = await db
    .select({ appId: apps.id, proj: projects.slug, app: apps.slug, port: apps.port })
    .from(apps)
    .innerJoin(projects, eq(apps.projectId, projects.id))
    .orderBy(projects.slug, apps.slug);

  const appsPerProject = new Map<string, number>();
  for (const r of rows) {
    appsPerProject.set(r.proj, (appsPerProject.get(r.proj) ?? 0) + 1);
  }
  return rows.map((r) => ({
    appId: r.appId,
    project: r.proj,
    app: r.app,
    port: r.port,
    mount: mountPath(r.proj, r.app, appsPerProject.get(r.proj) === 1),
  }));
}

export async function renderProjectsConf(): Promise<string> {
  return renderProjectsConfText(await appConfRows());
}

export type NginxApplyResult = {
  ok: boolean;
  message: string;
  rolledBack?: boolean;
};

/** Write `conf` as the projects include and reload; the previous include back if nginx -t refuses (T242). */
async function applyConf(conf: string): Promise<NginxApplyResult> {
  return applyWithRollback(conf, {
    read: () => fs.readFile(PROJECTS_CONF_PATH, "utf8").catch(() => null),
    write: async (text) => {
      await fs.mkdir(path.dirname(PROJECTS_CONF_PATH), { recursive: true });
      await fs.writeFile(PROJECTS_CONF_PATH, text, "utf8");
    },
    reload: async () => {
      try {
        // `sudo -n`: never prompt; the sudoers rule allows only RELOAD_CMD.
        const { stdout, stderr } = await execFileAsync("sudo", ["-n", RELOAD_CMD], {
          timeout: 15000,
        });
        return stdout || stderr || "nginx reloaded";
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error((err.stderr || err.message || "").trim());
      }
    },
  });
}

/**
 * Regenerate the projects include from the DB and reload Nginx via the
 * locked-down helper. Safe to call after any port change.
 */
export async function applyNginx(): Promise<NginxApplyResult> {
  return applyConf(await renderProjectsConf());
}

// ---- the routes page (T242) ----------------------------------------------------

/** The config root: nginx.conf's directory, where relative includes resolve. */
const NGINX_ROOT = process.env.NGINX_ROOT ?? "/etc/nginx";

/** An include pattern's files: a glob (`*`) in the last segment only, as the box's configs use. */
async function resolveInclude(pattern: string): Promise<{ file: string; text: string }[]> {
  const abs = path.isAbsolute(pattern) ? pattern : path.join(NGINX_ROOT, pattern);
  const dir = path.dirname(abs), base = path.basename(abs);
  let names: string[];
  if (base.includes("*")) {
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).sort();
  } else {
    names = [base];
  }
  const out: { file: string; text: string }[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text !== null) out.push({ file, text });
  }
  return out;
}

/** The working directory of a pid we own (others' are unreadable): null otherwise. */
async function cwdOf(pid: number | null): Promise<string | null> {
  if (!pid) return null;
  return fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
}

async function listeners(): Promise<ListenerInfo[]> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ss", ["-ltnH", "-p"], { timeout: 3000 }));
  } catch {
    return [];
  }
  const root = PROJECTS_ROOT.endsWith("/") ? PROJECTS_ROOT : `${PROJECTS_ROOT}/`;
  return Promise.all(
    parseSsListeners(stdout).map(async (l) => {
      const cwd = await cwdOf(l.pid);
      const project = cwd?.startsWith(root) ? cwd.slice(root.length).split("/")[0] || null : null;
      return { ...l, cwd, project };
    }),
  );
}

export type RouteSnapshot = {
  servers: ServerInfo[];
  routes: Route[];
  listeners: ListenerInfo[];
  apps: AppRow[];
  problems: Problem[];
  /** the generated include's path, and whether what's on disk matches the DB */
  generatedPath: string;
  generatedInSync: boolean;
  policy: PortPolicy;
  /** a subdomain route needs a one-time root include and the gateway (T242: not set up) */
  subdomainsEnabled: boolean;
  error?: string;
};

async function appRows(): Promise<AppRow[]> {
  const running = new Set(await listRunningSlugs().catch(() => [] as string[]));
  return (await appConfRows()).map((r) => ({ ...r, running: isAppServerRunning(running, r.project, r.app) }));
}

/** Everything the Nginx routes page shows: read from the config files, `ss`, the DB and the runner. */
export async function loadRouteSnapshot(): Promise<RouteSnapshot> {
  const generatedPath = path.resolve(PROJECTS_CONF_PATH);
  const [mainText, ls, appList, onDisk, rendered] = await Promise.all([
    fs.readFile(path.join(NGINX_ROOT, "nginx.conf"), "utf8").catch(() => null),
    listeners(),
    appRows(),
    fs.readFile(PROJECTS_CONF_PATH, "utf8").catch(() => null),
    renderProjectsConf(),
  ]);
  const base = { listeners: ls, apps: appList, generatedPath, generatedInSync: onDisk === rendered, policy: DEFAULT_PORT_POLICY, subdomainsEnabled: false };
  if (mainText === null) {
    return { ...base, servers: [], routes: [], problems: [], error: `${path.join(NGINX_ROOT, "nginx.conf")} could not be read` };
  }
  const top = await expandIncludes(parseNginx(mainText, path.join(NGINX_ROOT, "nginx.conf")), resolveInclude);
  const { servers, routes } = extractRoutes(top, (f) => path.resolve(f) === generatedPath);
  return { ...base, servers, routes, problems: findProblems({ routes, servers, listeners: ls, apps: appList }) };
}

export type PortChangePreview = { conflicts: Conflict[]; diff: DiffLine[]; changed: boolean };

/** What giving `appId` the port `port` would do: the conflicts, and the generated include's diff. */
export async function previewPortChange(appId: number, port: number | null): Promise<PortChangePreview> {
  const [rows, ls, appList] = await Promise.all([appConfRows(), listeners(), appRows()]);
  const conflicts = portChangeConflicts(appId, port, appList, ls);
  const before = renderProjectsConfText(rows);
  const after = renderProjectsConfText(rows.map((r) => (r.appId === appId ? { ...r, port } : r)));
  return { conflicts, diff: diffLines(before, after), changed: before !== after };
}

/** The guard (T241/T242): the reason another app's port can't be given to `appId`, or null. */
export async function portTakenBy(appId: number, port: number | null): Promise<string | null> {
  if (port === null) return null;
  const other = (await appConfRows()).find((r) => r.appId !== appId && r.port === port);
  return other ? `Port ${port} is already ${other.project}/${other.app || "(root)"}'s: give each app its own port.` : null;
}
