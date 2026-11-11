import "server-only";

import { execFile, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, openSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { cleanEnv } from "@/lib/clean-env.mjs";
import { runSlug } from "@/lib/run-slug";
import {
  cgroupMemBytes,
  containerEnvKeys,
  containerName,
  DEFAULT_RUN,
  defaultImage,
  dockerRunArgs,
  pinnedNodeMajor,
  type RunSettings,
  scopeArgs,
  scopeUnit,
} from "@/lib/run-isolation";

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
// a run's systemd scope, and its container's id (docker run --cidfile)
const unitPathFor = (slug: string) => path.join(RUN_LOG_ROOT, `${slug}.unit`);
const cidPathFor = (slug: string) => path.join(RUN_LOG_ROOT, `${slug}.cid`);
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

/**
 * Like {@link statusFor}, but for the `dev` script also treats a listening app
 * port as "running". A dev server started outside the runner — or one whose
 * tracked pid died while a forked worker (e.g. Next's `next-server`) kept the
 * port, leaving a STALE pid file — has no live pid file, so `statusFor` alone
 * reports it stopped even though it serves traffic. This mirrors the dashboard's
 * `getRunningInfo()` union (pid OR port), which reports a port-only server under
 * the app's dev slug, so the per-script dot and the dashboard agree.
 *
 * Pass `portPids` to reuse a single `ss` snapshot when rendering many scripts.
 */
export async function statusForWithPort(
  projectSlug: string,
  appSlug: string,
  script: string,
  port: number | null,
  portPids?: Map<number, number>,
): Promise<RunStatus> {
  const base = await statusFor(projectSlug, appSlug, script);
  if (base.running || script !== "dev" || port == null) return base;
  const map = portPids ?? (await listeningPortPids());
  const pid = map.get(port);
  return pid != null ? { ...base, running: true, pid } : base;
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
 * Sum the memory of the process SUBTREE rooted at each given pid — the process
 * itself plus every descendant, following PPID links in /proc. Each process counts
 * its PSS (its share of the pages it shares, from smaps_rollup), so the workers of
 * one server, sharing most of their memory, add up to what's really in use; RSS
 * where PSS can't be read. Unlike
 * {@link rssBytesByProcessGroup}, this is for tmux terminals: a pane's shell
 * (`pane_pid`) puts each foreground job in its OWN process group (job control), so
 * a pgid sum would miss the running command (claude/node) — walking the tree
 * captures the shell + command + its children. Returns bytes keyed by root pid.
 * One /proc scan serves every root passed in.
 */
export async function memBytesByProcessTree(
  rootPids: number[],
): Promise<Map<number, number>> {
  const rss = new Map<number, number>();
  const children = new Map<number, number[]>();
  let pids: string[];
  try {
    pids = await fs.readdir("/proc");
  } catch {
    return new Map();
  }
  await Promise.all(
    pids.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      let stat: string;
      try {
        stat = await fs.readFile(`/proc/${name}/stat`, "utf8");
      } catch {
        return; // exited between readdir and read, or unreadable
      }
      // comm (field 2) is parenthesized and may contain spaces/parens; split the
      // rest after the final ')'. Then fields[N-3] maps to /proc stat field N:
      // ppid = field 4 → fields[1]; rss (pages) = field 24 → fields[21].
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return;
      const fields = stat.slice(rparen + 2).split(" ");
      const ppid = Number(fields[1]);
      const rssPages = Number(fields[21]);
      const pid = Number(name);
      if (!Number.isFinite(ppid) || !Number.isFinite(rssPages)) return;
      rss.set(pid, rssPages * PAGE_SIZE);
      const sibs = children.get(ppid);
      if (sibs) sibs.push(pid);
      else children.set(ppid, [pid]);
    }),
  );

  const trees = new Map<number, number[]>();
  for (const root of rootPids) {
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue; // guard against cycles / repeated roots
      seen.add(pid);
      const kids = children.get(pid);
      if (kids) for (const k of kids) stack.push(k);
    }
    trees.set(root, [...seen]);
  }
  // (PSS only for the processes in a tree: smaps_rollup costs more than stat)
  const pss = new Map<number, number>();
  await Promise.all(
    [...new Set([...trees.values()].flat())].map(async (pid) => {
      try {
        const m = /^Pss:\s+(\d+) kB/m.exec(await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8"));
        if (m) pss.set(pid, Number(m[1]) * 1024);
      } catch {
        /* gone, or not ours: its RSS stands */
      }
    }),
  );
  const out = new Map<number, number>();
  for (const [root, pids] of trees) out.set(root, pids.reduce((n, pid) => n + (pss.get(pid) ?? rss.get(pid) ?? 0), 0));
  return out;
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
  return Promise.all(
    pids.map(async ({ slug, pid }) => ({
      slug,
      pid,
      rssBytes: (await containerMemBytes(slug)) ?? rssByPgid.get(pid) ?? 0,
    })),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// genie's systemd user manager (there when genie lingers: `loginctl enable-linger genie`, deploy/install.sh).
const USER_RUNTIME_DIR = `/run/user/${process.getuid?.() ?? 0}`;
const DOCKER_SOCK = "/var/run/docker.sock";

/** What this box can run an app in: its own systemd scope, and Docker. */
export async function runCapabilities(): Promise<{ scopes: boolean; docker: boolean }> {
  const can = (file: string) =>
    fs.access(file, fsConstants.R_OK | fsConstants.W_OK).then(
      () => true,
      () => false,
    );
  const [scopes, docker] = await Promise.all([can(`${USER_RUNTIME_DIR}/bus`), can(DOCKER_SOCK)]);
  return { scopes, docker };
}

/**
 * The child's environment: only what clean-env.mjs keeps (the user's basics, the locale, PUBLIC_HOST), plus its PORT.
 * Never the admin's own: its NODE_ENV=production broke `next dev` (emotion's `jsxDEV is not a function`), `next dev`'s
 * TURBOPACK=1 killed apps whose script passes --webpack, its DATABASE_URL and basePath won over the app's .env.local
 * (Next doesn't override a variable that's already set), and its secrets have no business in an app.
 */
function childEnv(port: number | null): NodeJS.ProcessEnv {
  return cleanEnv(process.env, {
    FORCE_COLOR: "0",
    ...(port ? { PORT: String(port) } : {}),
    // systemd-run / systemctl --user find genie's user manager by it (admin.service doesn't have it)
    XDG_RUNTIME_DIR: USER_RUNTIME_DIR,
  });
}

const userEnv = () => cleanEnv(process.env, { XDG_RUNTIME_DIR: USER_RUNTIME_DIR });

/**
 * The image a docker run uses: the app's own, else Node at the major the app (or its project) pins in .nvmrc /
 * .node-version, else the host's major (node_modules were installed by the host's npm).
 */
export async function resolveImage(appDir: string, image: string | null): Promise<string> {
  if (image) return image;
  for (const dir of new Set([appDir, projectDirOf(appDir)]))
    for (const file of [".nvmrc", ".node-version"]) {
      const text = await fs.readFile(path.join(dir, file), "utf8").catch(() => null);
      const major = text == null ? null : pinnedNodeMajor(text);
      if (major) return defaultImage(major);
    }
  return defaultImage(Number(process.versions.node.split(".")[0]));
}

/** The project's top folder an app dir sits in (what a container mounts). */
function projectDirOf(appDir: string): string {
  const root = path.resolve(PROJECTS_ROOT);
  return path.join(root, path.relative(root, appDir).split(path.sep)[0]);
}

const readText = (file: string) =>
  fs.readFile(file, "utf8").then(
    (t) => t.trim() || null,
    () => null,
  );

/**
 * Clear what a run left behind: whatever is still in its systemd scope (a worker that outlived npm), its container,
 * and their files. Before a start (the run is over by then: its pid is gone) and at the end of a stop.
 */
async function sweep(slug: string, docker = false): Promise<void> {
  const unit = await readText(unitPathFor(slug));
  if (unit) {
    await execFileP("systemctl", ["--user", "kill", "--signal=SIGKILL", unit], { env: userEnv(), timeout: 5000 }).catch(
      () => {}, // gone with its last process: the usual case
    );
  }
  // (a docker start clears its name whether or not the last run got as far as writing the id; docker refuses both an
  // existing cidfile and a name in use)
  if (docker || (await readText(cidPathFor(slug)))) {
    await execFileP("docker", ["rm", "--force", containerName(slug)], { timeout: 20_000 }).catch(() => {});
  }
  await Promise.all([fs.rm(unitPathFor(slug), { force: true }), fs.rm(cidPathFor(slug), { force: true })]);
}

/**
 * What a docker run's container has in memory, from its cgroup; null when the run isn't one (or its container is
 * gone). The runner's pid there is the `docker run` client's, whose own process group is only the client.
 */
export async function containerMemBytes(slug: string): Promise<number | null> {
  const id = await readText(cidPathFor(slug));
  if (!id || !/^[0-9a-f]{12,64}$/.test(id)) return null;
  // the systemd cgroup driver's path, then cgroupfs'
  for (const dir of [`/sys/fs/cgroup/system.slice/docker-${id}.scope`, `/sys/fs/cgroup/docker/${id}`]) {
    const current = await fs.readFile(`${dir}/memory.current`, "utf8").catch(() => null);
    if (current != null) return cgroupMemBytes(current, await fs.readFile(`${dir}/memory.stat`, "utf8").catch(() => ""));
  }
  return null;
}

export type StartOpts = {
  dir: string;
  projectSlug: string;
  appSlug: string;
  port: number | null;
  script: string;
  /** How to run it (the app's settings); the default runs it on the box. */
  run?: RunSettings;
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
  const run = opts.run ?? DEFAULT_RUN;
  const can = await runCapabilities();
  if (run.isolation === "docker" && !can.docker) {
    throw new Error(`Docker isn't available here (no access to ${DOCKER_SOCK}): run it on the box, or install Docker`);
  }
  await fs.mkdir(RUN_LOG_ROOT, { recursive: true });
  await sweep(slug, run.isolation === "docker");

  const npm = ["npm", "run", script];
  const env = childEnv(port);
  let cmd: string, args: string[], how: string;
  if (run.isolation === "docker") {
    const image = await resolveImage(appDir, run.image);
    cmd = "docker";
    args = dockerRunArgs({
      name: containerName(slug),
      image,
      projectDir: projectDirOf(appDir),
      appDir,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      envKeys: containerEnvKeys(env),
      memMaxMb: run.memMaxMb,
      cpus: run.cpus,
      cidFile: cidPathFor(slug),
      slug,
      argv: npm,
    });
    how = `in docker (${image})`;
  } else if (can.scopes) {
    const unit = scopeUnit(slug);
    cmd = "systemd-run";
    args = scopeArgs(unit, run, npm);
    await fs.writeFile(unitPathFor(slug), unit);
    how = `in ${unit}`;
  } else {
    [cmd, ...args] = npm;
    how = "on the box";
    if (run.memMaxMb || run.cpus) how += " (caps not applied: no systemd user manager, `sudo loginctl enable-linger genie`)";
  }
  const caps = [run.memMaxMb && `${run.memMaxMb} MB`, run.cpus && `${run.cpus} CPU`].filter(Boolean).join(", ");

  const logPath = logPathFor(slug);
  await fs.appendFile(
    logPath,
    `\n[admin ${new Date().toISOString()}] starting "${slug}" — npm run ${script}` +
      ` (PORT=${port ?? "unset"}${caps ? `, max ${caps}` : ""}) in ${appDir}, ${how}\n`,
  );

  const fd = openSync(logPath, "a");
  try {
    const child = spawn(cmd, args, {
      cwd: appDir,
      detached: true, // new session + process group (pgid = child.pid; systemd-run execs npm in place)
      stdio: ["ignore", fd, fd],
      env,
    });
    child.on("error", (e) => {
      void fs.appendFile(logPath, `[admin ${new Date().toISOString()}] couldn't start ${cmd}: ${e.message}\n`).catch(() => {});
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
  // A container first: `docker stop` gives its npm the SIGTERM (through tini) and the client exits with it; signalling
  // only the client could leave the container running.
  const cid = await readText(cidPathFor(slug));
  if (cid && pid != null && pidAlive(pid)) {
    await execFileP("docker", ["stop", "-t", "5", cid], { timeout: 20_000 }).catch(() => {});
  }
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
  // what's left in its scope or container, even when the pid was already gone (a worker that outlived npm)
  await sweep(slug);
  await fs.rm(pidPathFor(slug), { force: true });
  return statusForSlug(slug, null);
}

export async function restartApp(opts: StartOpts): Promise<RunStatus> {
  await stopApp(opts.projectSlug, opts.appSlug, opts.script);
  return startApp(opts);
}
