import "server-only";

import { promises as fs } from "node:fs";

import { agentBrowserSessions, currentPage, devtoolsPort, listChromePages } from "@/lib/chrome";
import { readRegistry } from "@/lib/claude-comms";
import { descendants, parseProcPidStat, type ProcStat, type TickReading, treeCpuPercent, treeMemMB } from "@/lib/proc-tree";

/**
 * Who is using a browser: the open agent-browser sessions (a live daemon,
 * `~/.agent-browser/<session>.pid`), each with the Chrome it drives (the whole
 * process tree under the daemon: CPU, memory, start) and the page it is on
 * (title and host only: never the URL's path, query or the page's contents).
 * The team names sessions after the agent (`--session Alex`); "default" or a
 * name that is no live Claude session's is flagged as unowned.
 */

export type BrowserSession = {
  /** agent-browser's --session name */
  session: string;
  /** the Claude session (agent) of that name, null if none is live */
  agent: string | null;
  /** "default", or a name that matches no live agent */
  unowned: boolean;
  /** Chrome is running under the daemon */
  running: boolean;
  /** the Chrome tree's CPU since the previous reading (100 = one core); null on the first */
  cpuPercent: number | null;
  /** the Chrome tree's resident memory */
  memMB: number;
  procs: number;
  /** when Chrome started (ISO), null when it isn't running */
  startedAt: string | null;
  /** the page it is on: its title (cut to 120) and host; null when not known */
  page: { title: string; host: string | null } | null;
};

export type BrowsersResponse = { sessions: BrowserSession[]; at: string };

const CLK_TCK = 100; // getconf CLK_TCK on this host
const MIN_MS = 1000;

let prev: TickReading | null = null;
let last: { at: number; res: BrowsersResponse } | null = null;

async function readAll(): Promise<Map<number, ProcStat>> {
  const out = new Map<number, ProcStat>();
  const pids = (await fs.readdir("/proc")).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const p = parseProcPidStat(pid, await fs.readFile(`/proc/${pid}/stat`, "utf8"));
        if (p) out.set(pid, p);
      } catch {
        /* gone meanwhile */
      }
    }),
  );
  return out;
}

/** The DevTools port of the Chrome started by the daemon (its --remote-debugging-port, else DevToolsActivePort). */
async function portOf(chromePid: number): Promise<number | null> {
  let argv: string[];
  try {
    argv = (await fs.readFile(`/proc/${chromePid}/cmdline`, "utf8")).split("\0");
  } catch {
    return null;
  }
  const arg = (flag: string) => argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
  const port = Number(arg("--remote-debugging-port"));
  if (Number.isInteger(port) && port > 0) return port;
  const dir = arg("--user-data-dir");
  return dir ? devtoolsPort(dir) : null;
}

/** The current page's title and host (no path, query or contents). */
async function pageOf(chromePid: number): Promise<BrowserSession["page"]> {
  const port = await portOf(chromePid);
  if (!port) return null;
  const page = currentPage(await listChromePages(port));
  if (!page) return null;
  let host: string | null = null;
  try {
    const u = new URL(page.url);
    if (u.protocol === "http:" || u.protocol === "https:") host = u.host;
  } catch {
    /* not a URL */
  }
  return { title: page.title.slice(0, 120), host };
}

export async function listBrowserSessions(): Promise<BrowsersResponse> {
  if (last && Date.now() - last.at < MIN_MS) return last.res;
  const [daemons, procs, uptimeText, registry] = await Promise.all([
    agentBrowserSessions(),
    readAll(),
    fs.readFile("/proc/uptime", "utf8").catch(() => "0"),
    readRegistry().catch(() => ({ entries: [] as { name?: string | null }[] })),
  ]);
  const uptime = Number(uptimeText.split(" ")[0]) || 0;
  const agents = new Map<string, string>();
  for (const e of registry.entries) if (e.name) agents.set(e.name.toLowerCase(), e.name);
  const bootMs = Date.now() - uptime * 1000;

  const sessions: BrowserSession[] = [];
  for (const [pid, session] of daemons) {
    if (!procs.has(pid)) continue; // a stale pid file: the session is closed
    const tree = descendants(procs.values(), pid);
    // Chrome's browser process: the daemon's child with the earliest start.
    const root = tree
      .map((p) => procs.get(p)!)
      .filter((p) => p.ppid === pid)
      .sort((a, b) => a.startTicks - b.startTicks)[0];
    const agent = session === "default" ? null : (agents.get(session.toLowerCase()) ?? null);
    sessions.push({
      session,
      agent,
      unowned: !agent,
      running: tree.length > 0,
      cpuPercent: tree.length ? treeCpuPercent(tree, procs, uptime, prev, CLK_TCK) : null,
      memMB: treeMemMB(tree, procs),
      procs: tree.length,
      startedAt: root ? new Date(bootMs + (root.startTicks / CLK_TCK) * 1000).toISOString() : null,
      page: root ? await pageOf(root.pid) : null,
    });
  }
  sessions.sort((a, b) => a.session.localeCompare(b.session));
  prev = { uptime, ticks: new Map([...procs].map(([p, s]) => [p, s.ticks])) };
  const res = { sessions, at: new Date().toISOString() };
  last = { at: Date.now(), res };
  return res;
}
