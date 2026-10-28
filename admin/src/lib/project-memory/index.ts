import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { projects } from "@/db/schema";
import { RUN_LOG_ROOT } from "@/lib/runner";

import { measureProjects, projectContainers, type ProjectContainer, type ProjectMemorySnapshot } from "./core.mjs";

export type { MemoryGroup, MemoryProcess, ProjectMemory, ProjectMemorySnapshot } from "./core.mjs";

export type ProjectMemoryStatus = ProjectMemorySnapshot & {
  /** Warn above these (MB), by project slug. */
  limits: Record<string, number>;
  server: { totalBytes: number; availableBytes: number };
};

const ROOT = process.env.PROJECTS_ROOT ?? "/opt/project/projects";
/** Every open tab polls: one measurement serves them all for this long. */
const FRESH_MS = 4000;
/** `docker stats` takes a second or two, so containers are looked at less often. */
const DOCKER_MS = 15_000;

type Cache = {
  snapshot: ProjectMemorySnapshot | null;
  pending: Promise<ProjectMemorySnapshot> | null;
  containers: ProjectContainer[];
  containersAt: number;
  containersPending: Promise<void> | null;
};
// (on globalThis: dev reloads re-run this module, and one cache is enough)
const g = globalThis as typeof globalThis & { __projectMemory?: Cache };
const cache: Cache = (g.__projectMemory ??= { snapshot: null, pending: null, containers: [], containersAt: 0, containersPending: null });

function refreshContainers() {
  if (cache.containersPending || Date.now() - cache.containersAt < DOCKER_MS) return;
  cache.containersPending = projectContainers(ROOT)
    .then((c) => {
      cache.containers = c;
      cache.containersAt = Date.now();
    })
    .finally(() => {
      cache.containersPending = null;
    });
}

const pexec = promisify(execFile);
/** The admin's tmux sessions (src/lib/terminals.ts): "admin-<terminal name>". */
const TERMINAL_PREFIX = "admin-";

/** Each admin terminal's pane pids → its name. */
async function terminalPanes(): Promise<Map<number, string>> {
  try {
    const { stdout } = await pexec("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"], { timeout: 5000 });
    const out = new Map<number, string>();
    for (const line of stdout.split("\n")) {
      const [session, pid] = line.split("\t");
      if (session?.startsWith(TERMINAL_PREFIX) && Number(pid) > 0) out.set(Number(pid), session.slice(TERMINAL_PREFIX.length));
    }
    return out;
  } catch {
    return new Map(); // no tmux server: no terminals
  }
}

/**
 * Names the admin terminal each group runs in: up its processes' parents to a
 * terminal's pane. A Claude session started some other way (a background
 * session, an SSH login) has none.
 */
async function markTerminals(snapshot: ProjectMemorySnapshot): Promise<ProjectMemorySnapshot> {
  const panes = await terminalPanes();
  if (!panes.size) return snapshot;
  const parent = new Map<number, number>();
  const ppidOf = async (pid: number) => {
    if (!parent.has(pid)) {
      const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      parent.set(pid, Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[1]) || 0);
    }
    return parent.get(pid)!;
  };
  const terminalOf = async (pid: number) => {
    for (let p = pid, hops = 0; p > 1 && hops < 64; p = await ppidOf(p), hops++) if (panes.has(p)) return panes.get(p)!;
    return null;
  };
  for (const project of snapshot.projects)
    for (const g of project.groups) {
      g.terminal = null;
      for (const p of g.procs) if ((g.terminal = await terminalOf(p.pid))) break;
    }
  return snapshot;
}

/** What each project's processes and containers have in memory, at most a few seconds old. */
export async function projectMemory(): Promise<ProjectMemorySnapshot> {
  if (cache.snapshot && Date.now() - cache.snapshot.ts < FRESH_MS) return cache.snapshot;
  // (the first look waits for the containers; after that they refresh in the background)
  if (!cache.containersAt) {
    refreshContainers();
    await cache.containersPending;
  } else refreshContainers();
  cache.pending ??= measureProjects({ root: ROOT, runDir: RUN_LOG_ROOT, containers: cache.containers })
    .then(markTerminals)
    .then((s) => (cache.snapshot = s))
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}

export async function memoryLimits(): Promise<Record<string, number>> {
  const rows = await db
    .select({ slug: projects.slug, mb: projects.memLimitMb })
    .from(projects)
    .where(isNotNull(projects.memLimitMb));
  return Object.fromEntries(rows.map((r) => [r.slug, r.mb!]));
}

/** Sets (or, with null, clears) a project's limit. False if there's no such project. */
export async function setMemoryLimit(slug: string, mb: number | null): Promise<boolean> {
  const rows = await db.update(projects).set({ memLimitMb: mb }).where(eq(projects.slug, slug)).returning({ id: projects.id });
  return rows.length > 0;
}

/** MemTotal and MemAvailable: what's free to use, page cache included, unlike os.freemem(). */
async function serverMemory() {
  try {
    const raw = await fs.readFile("/proc/meminfo", "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(raw)?.[1] ?? 0) * 1024;
    return { totalBytes: kb("MemTotal"), availableBytes: kb("MemAvailable") };
  } catch {
    return { totalBytes: 0, availableBytes: 0 };
  }
}

export async function projectMemoryStatus(): Promise<ProjectMemoryStatus> {
  const [snapshot, limits, server] = await Promise.all([projectMemory(), memoryLimits().catch(() => ({})), serverMemory()]);
  return { ...snapshot, limits, server };
}
