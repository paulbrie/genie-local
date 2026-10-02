import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects } from "@/db/schema";

const execFileAsync = promisify(execFile);

/** Genie-owned file that the main Nginx server block `include`s. */
const PROJECTS_CONF_PATH =
  process.env.NGINX_PROJECTS_CONF ?? "/opt/project/admin/nginx/projects.conf";
/** Root-owned helper genie may run passwordless (only `nginx -t && reload`). */
const RELOAD_CMD =
  process.env.NGINX_RELOAD_CMD ?? "/usr/local/bin/ft-nginx-reload";

// Slugs come from directory names; only allow a safe charset in generated
// config to prevent any Nginx directive injection.
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;

function isValidPort(p: number | null): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/** Build the Nginx `location` blocks for all apps that have a valid port. */
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

export async function renderProjectsConf(): Promise<string> {
  // All apps (to know per-project counts), plus ports for routing.
  const rows = await db
    .select({ proj: projects.slug, app: apps.slug, port: apps.port })
    .from(apps)
    .innerJoin(projects, eq(apps.projectId, projects.id))
    .orderBy(projects.slug, apps.slug);

  const appsPerProject = new Map<string, number>();
  for (const r of rows) {
    appsPerProject.set(r.proj, (appsPerProject.get(r.proj) ?? 0) + 1);
  }

  const blocks: string[] = [
    "# GENERATED from the admin DB (apps.port). Do not edit by hand;",
    "# it is overwritten whenever a port is changed in the admin UI.",
    "# The prefix is PRESERVED (no strip): each app must set its Next basePath",
    "# to the mount path shown in the comment.",
    "",
  ];

  for (const r of rows) {
    if (!isValidPort(r.port)) continue;
    if (!SAFE_SLUG.test(r.proj)) continue;
    if (r.app !== "" && !SAFE_SLUG.test(r.app)) continue;

    const single = appsPerProject.get(r.proj) === 1;
    const mount = mountPath(r.proj, r.app, single);
    blocks.push(
      `# ${r.proj}/${r.app || "(root)"} — app basePath must be '${mount}'`,
      // No trailing slash on proxy_pass -> the full request URI is preserved.
      `location ${mount} { proxy_pass http://127.0.0.1:${r.port}; }`,
      "",
    );
  }
  return blocks.join("\n");
}

export type NginxApplyResult = {
  ok: boolean;
  message: string;
};

/**
 * Regenerate the projects include from the DB and reload Nginx via the
 * locked-down helper. Safe to call after any port change.
 */
export async function applyNginx(): Promise<NginxApplyResult> {
  const conf = await renderProjectsConf();
  try {
    await fs.mkdir(path.dirname(PROJECTS_CONF_PATH), { recursive: true });
    await fs.writeFile(PROJECTS_CONF_PATH, conf, "utf8");
  } catch (e) {
    return {
      ok: false,
      message: `failed writing ${PROJECTS_CONF_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  try {
    // `sudo -n`: never prompt; the sudoers rule allows only RELOAD_CMD.
    const { stdout, stderr } = await execFileAsync("sudo", ["-n", RELOAD_CMD], {
      timeout: 15000,
    });
    return { ok: true, message: (stdout || stderr || "nginx reloaded").trim() };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      ok: false,
      message: `nginx reload failed: ${(err.stderr || err.message || "").trim()}`,
    };
  }
}
