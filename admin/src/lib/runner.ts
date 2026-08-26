import "server-only";

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { runSlug } from "@/lib/run-slug";

export { runSlug };

// Where per-(app, script) logs are written. The admin Logs page reads /tmp, so
// these land under /tmp/projects/<slug>.log and show up there automatically.
export const RUN_LOG_ROOT = process.env.RUN_LOG_ROOT ?? "/tmp/projects";
const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? "/opt/project/projects";

export type RunStatus = {
  slug: string;
  running: boolean;
  pid: number | null;
  /** Path relative to /tmp (the id the Logs page uses). */
  logFile: string;
};

export type RunInfo = {
  slug: string;
  pid: number;
  /** Resident memory of the whole app process group, in bytes. */
  rssBytes: number;
};

const logPathFor = (slug: string) => path.join(RUN_LOG_ROOT, `${slug}.log`);
const pidPathFor = (slug: string) => path.join(RUN_LOG_ROOT, `${slug}.pid`);
const logFileRel = (slug: string) =>
  path.relative("/tmp", logPathFor(slug)); // "projects/<slug>.log"

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not signalable (shouldn't happen, same user) → alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPid(slug: string): Promise<number | null> {
  try {
    const n = parseInt((await fs.readFile(pidPathFor(slug), "utf8")).trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Resolve an app dir, rejecting anything outside PROJECTS_ROOT. */
function assertUnderProjects(dir: string): string {
  const root = path.resolve(PROJECTS_ROOT);
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("app directory is outside PROJECTS_ROOT");
  }
  return resolved;
}

function statusForSlug(slug: string, pid: number | null): RunStatus {
  const running = pid != null && pidAlive(pid);
  return { slug, running, pid: running ? pid : null, logFile: logFileRel(slug) };
}

/** Live status of one app+script unit. */
export async function statusFor(
  projectSlug: string,
  appSlug: string,
  script: string,
): Promise<RunStatus> {
  const slug = runSlug(projectSlug, appSlug, script);
  return statusForSlug(slug, await readPid(slug));
}

/** Alive (slug, pid) pairs — one per pid file whose process is still running. */
export async function listRunningPids(): Promise<
  { slug: string; pid: number }[]
> {
  let entries: string[];
  try {
    entries = await fs.readdir(RUN_LOG_ROOT);
  } catch {
    return [];
  }
  const running: { slug: string; pid: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".pid")) continue;
    const slug = name.slice(0, -4);
    const pid = await readPid(slug);
    if (pid != null && pidAlive(pid)) running.push({ slug, pid });
  }
  return running;
}

/** All run-slugs whose process is currently alive (for dashboard status dots). */
export async function listRunningSlugs(): Promise<string[]> {
  return (await listRunningPids()).map((r) => r.slug);
}

// /proc/<pid>/stat reports RSS in pages. Linux pages are 4 KiB on every arch we
// run on; there is no libc-free way to read PAGE_SIZE from Node, so assume it.
const PAGE_SIZE = 4096;

/**
 * Sum resident memory (RSS) per process group by scanning /proc. Apps are
 * started detached (own session/process group, pgid = the pid we store), and
 * every descendant inherits that pgid — so a group's total RSS is the memory of
 * the whole app (npm → node → next-server → workers). Returns bytes keyed by pgid.
 */
export async function rssBytesByProcessGroup(): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  let pids: string[];
  try {
    pids = await fs.readdir("/proc");
  } catch {
    return totals;
  }
  await Promise.all(
    pids.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      let stat: string;
      try {
        stat = await fs.readFile(`/proc/${name}/stat`, "utf8");
      } catch {
        return; // process exited between readdir and read, or unreadable
      }
      // Field 2 (comm) is parenthesized and may itself contain spaces/parens,
      // so split the fields AFTER the final ')'. Then fields[0] is field 3
      // (state) and field N maps to fields[N - 3].
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return;
      const fields = stat.slice(rparen + 2).split(" ");
      const pgrp = Number(fields[2]); // field 5
      const rssPages = Number(fields[21]); // field 24
      if (!Number.isFinite(pgrp) || !Number.isFinite(rssPages)) return;
      totals.set(pgrp, (totals.get(pgrp) ?? 0) + rssPages * PAGE_SIZE);
    }),
  );
  return totals;
}

/**
 * Map each currently-LISTENING TCP port to a pid holding it. Lets the dashboard
 * treat an app as running when its configured port is up, even if the server
 * wasn't started through the runner (e.g. `npm run dev` in a terminal) or its
 * tracked pid died while an orphaned server kept the port. Uses `ss`; returns an
 * empty map if it's unavailable, so callers degrade to pid-file detection.
 */
export async function listeningPortPids(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  let stdout: string;
  try {
    ({ stdout } = await execFileP("ss", ["-ltnH", "-p"], { timeout: 2000 }));
  } catch {
    return map;
  }
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // Columns: State Recv-Q Send-Q Local-Addr:Port Peer-Addr:Port [users:(…)].
    // The first four are space-free, so the local address is reliably col 4;
    // the pid lives in the trailing users:() field.
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isFinite(port)) continue;
    const m = /pid=(\d+)/.exec(line);
    if (!m) continue;
    if (!map.has(port)) map.set(port, Number(m[1]));
  }
  return map;
}

/** Process-group id of a pid, read from /proc; null if it's gone. */
export async function pgidOf(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    // After the comm field: fields[0]=state, fields[2]=pgrp (stat field 5).
    const pgrp = Number(stat.slice(rparen + 2).split(" ")[2]);
    return Number.isFinite(pgrp) ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * Alive run-slugs plus the resident memory of each one's process group, for the
 * dashboard's per-project memory readout. RSS is summed across the group, so
 * shared pages are counted once per process (the usual `ps`-style approximation).
 */
export async function listRunning(): Promise<RunInfo[]> {
  const pids = await listRunningPids();
  if (pids.length === 0) return [];
  const rssByPgid = await rssBytesByProcessGroup();
  return pids.map(({ slug, pid }) => ({
    slug,
    pid,
    rssBytes: rssByPgid.get(pid) ?? 0,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the child's environment. The admin runs under `next dev`, which injects
 * its own bundler/runtime vars (e.g. TURBOPACK=1) into `process.env`. Those must
 * NOT leak into a spawned app or they collide with the app's own bundler choice
 * — e.g. an app whose script passes `--webpack` errors out with "Multiple
 * bundler flags set: TURBOPACK=1, --webpack" and exits immediately.
 */
function childEnv(port: number | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "TURBOPACK" ||
      key === "NEXT_RUNTIME" ||
      key.startsWith("__NEXT") ||
      key.startsWith("__TURBOPACK") ||
      key.startsWith("TURBOPACK_")
    ) {
      delete env[key];
    }
  }
  env.FORCE_COLOR = "0";
  if (port) env.PORT = String(port);
  return env;
}

export type StartOpts = {
  dir: string;
  projectSlug: string;
  appSlug: string;
  port: number | null;
  script: string;
};

/**
 * Start an app's `npm run <script>` as a DETACHED child (own process group /
 * session) so it outlives both the request and an admin.service restart. All
 * output is appended to /tmp/projects/<app>-<script>.log. Keyed per (app,
 * script): starting `build` does not touch a running `dev`, etc.
 */
export async function startApp(opts: StartOpts): Promise<RunStatus> {
  const { projectSlug, appSlug, port, script } = opts;
  const slug = runSlug(projectSlug, appSlug, script);

  const current = statusForSlug(slug, await readPid(slug));
  if (current.running) return current; // idempotent — don't double-start

  const appDir = assertUnderProjects(opts.dir);
  await fs.mkdir(RUN_LOG_ROOT, { recursive: true });
  const logPath = logPathFor(slug);
  await fs.appendFile(
    logPath,
    `\n[admin ${new Date().toISOString()}] starting "${slug}" — npm run ${script}` +
      ` (PORT=${port ?? "unset"}) in ${appDir}\n`,
  );

  const fd = openSync(logPath, "a");
  try {
    const child = spawn("npm", ["run", script], {
      cwd: appDir,
      detached: true, // new session + process group (pgid = child.pid)
      stdio: ["ignore", fd, fd],
      env: childEnv(port),
    });
    child.unref();
    if (child.pid) await fs.writeFile(pidPathFor(slug), String(child.pid));
  } finally {
    closeSync(fd); // parent's copy; the child keeps its own dup
  }

  return statusForSlug(slug, await readPid(slug));
}

/** Stop the whole process group for one app+script unit (SIGTERM → SIGKILL). */
export async function stopApp(
  projectSlug: string,
  appSlug: string,
  script: string,
): Promise<RunStatus> {
  const slug = runSlug(projectSlug, appSlug, script);
  const pid = await readPid(slug);
  if (pid != null && pidAlive(pid)) {
    // Negative pid → signal the entire process group (npm + node + children).
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 15 && pidAlive(pid); i++) await sleep(200);
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await fs.appendFile(
      logPathFor(slug),
      `[admin ${new Date().toISOString()}] stopped "${slug}"\n`,
    ).catch(() => {});
  }
  await fs.rm(pidPathFor(slug), { force: true });
  return statusForSlug(slug, null);
}

export async function restartApp(opts: StartOpts): Promise<RunStatus> {
  await stopApp(opts.projectSlug, opts.appSlug, opts.script);
  return startApp(opts);
}
