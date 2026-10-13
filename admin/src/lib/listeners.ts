import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { parseSsListeners, serviceOfCgroup, type ListenerInfo } from "@/lib/nginx-routes";
import { PROJECTS_ROOT } from "@/lib/signals";

const execFileAsync = promisify(execFile);

/** A systemd unit's main pid (`systemctl show`, read-only), or null. */
async function mainPidOf(unit: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["show", "-p", "MainPID", "--value", `${unit}.service`], { timeout: 2000 });
    const pid = Number(stdout.trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** A pid's parent, from /proc/<pid>/stat (after the command's closing paren: it may hold spaces). */
async function parentOf(pid: number): Promise<number | null> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (!stat) return null;
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isFinite(ppid) ? ppid : null;
}

/** Whether `pid` is `main` or one of its descendants (at most 12 levels up). */
async function descendsFrom(pid: number, main: number): Promise<boolean> {
  let p: number | null = pid;
  for (let i = 0; p && p > 1 && i < 12; i++) {
    if (p === main) return true;
    p = await parentOf(p);
  }
  return false;
}

/** Read a /proc file of a pid we own (others' are unreadable): null otherwise. */
const proc = (pid: number | null, file: string) => (pid ? fs.readFile(`/proc/${pid}/${file}`, "utf8").catch(() => null) : Promise.resolve(null));

/**
 * What listens on each TCP port (T242), told: `ss`'s pid and process, and for our
 * own processes their working directory (→ the project), their systemd unit (from
 * the cgroup: admin, admin-dev, code-server) and their command. Empty if `ss` fails.
 */
export async function readListeners(): Promise<ListenerInfo[]> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ss", ["-ltnH", "-p"], { timeout: 3000 }));
  } catch {
    return [];
  }
  const root = PROJECTS_ROOT.endsWith("/") ? PROJECTS_ROOT : `${PROJECTS_ROOT}/`;
  const mains = new Map<string, Promise<number | null>>();
  return Promise.all(
    parseSsListeners(stdout).map(async (l) => {
      const [cwd, cgroup, cmdline] = await Promise.all([
        l.pid ? fs.readlink(`/proc/${l.pid}/cwd`).catch(() => null) : null,
        proc(l.pid, "cgroup"),
        proc(l.pid, "cmdline"),
      ]);
      const project = cwd?.startsWith(root) ? cwd.slice(root.length).split("/")[0] || null : null;
      // (argv[0..1], e.g. "/usr/bin/node /opt/project/admin/server.mjs"; no further, arguments may carry anything)
      const command = cmdline ? cmdline.split("\0").filter(Boolean).slice(0, 2).join(" ") || null : null;
      // the unit's name only for its own server (its main process or a child of it): a tool started from a terminal
      // the admin opened, or reparented to init, runs in the admin's cgroup too, but isn't the admin
      let service = cgroup ? serviceOfCgroup(cgroup) : null;
      if (service && l.pid) {
        if (!mains.has(service)) mains.set(service, mainPidOf(service));
        const main = await mains.get(service)!;
        if (!main || !(await descendsFrom(l.pid, main))) service = null;
      }
      return { ...l, cwd, project, service, command };
    }),
  );
}
