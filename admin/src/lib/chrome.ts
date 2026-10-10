import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readRegistry } from "@/lib/claude-comms";

const execFileAsync = promisify(execFile);

/**
 * Chrome/Chromium piles up on this box because each agent-browser session
 * spawns a headless instance (~12 processes, ~1.3 GB) under its own
 * `--user-data-dir=/tmp/agent-browser-chrome-<uuid>`, and idle ones are rarely
 * closed. The vps-stats daemon only reports process *names* (not full argv), so
 * we can't group by user-data-dir from there — instead we read `/proc` directly
 * here and fold every process of an instance into one row.
 */

const PAGE_SIZE = 4096; // getconf PAGESIZE on this host
const CLK_TCK = 100; // getconf CLK_TCK on this host
const AGENT_BROWSER_PREFIX = "/tmp/agent-browser-chrome-";

export type ChromeProc = {
  pid: number;
  ppid: number;
  memMB: number; // resident, MB
  type: string; // --type=… (renderer/gpu-process/utility/…), "" for the root
};

export type ChromeInstance = {
  /** Stable id — the user-data-dir path (unique per instance). */
  userDataDir: string;
  /** Short label: the uuid for agent-browser dirs, else the dir basename. */
  label: string;
  /** True when the dir lives under /tmp/agent-browser-chrome-. */
  agentBrowser: boolean;
  /** The browser (root) process — the one without a --type= flag. */
  rootPid: number;
  pids: number[];
  procCount: number;
  memMB: number; // summed resident memory across the instance
  ageSeconds: number; // age of the root process
  /** How DevTools was enabled: a port (viewable), a pipe (Playwright's default: not), or not at all. */
  debug: "port" | "pipe" | "none";
  /** The DevTools port, when it can be viewed. */
  devtoolsPort: number | null;
  /** Why it can't be viewed, or null if it can. */
  notViewable: string | null;
  /** Who started it: the Claude session (agent name) or tmux session it runs under, if any. */
  owner: string | null;
};

type RawProc = {
  pid: number;
  ppid: number;
  memMB: number;
  type: string;
  userDataDir: string;
  startTicks: number;
  pipe: boolean;
  /** --remote-debugging-port's value (0: Chrome picks one and writes DevToolsActivePort), null if absent */
  portArg: number | null;
};

function argOf(argv: string[], flag: string): string | null {
  const eq = `${flag}=`;
  for (const a of argv) if (a.startsWith(eq)) return a.slice(eq.length);
  return null;
}

/** Parse `/proc/<pid>/stat`, robust to spaces/parens in the comm field. */
function parseStat(stat: string): { ppid: number; startTicks: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after comm: state ppid pgrp … starttime(field 22). After the ')'
  // the first token is `state`, so ppid is index 1 and starttime index 19.
  const rest = stat.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(ppid)) return null;
  return { ppid, startTicks: Number.isFinite(startTicks) ? startTicks : 0 };
}

async function readProc(pid: number): Promise<RawProc | null> {
  let cmdline: string;
  try {
    cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null; // process vanished or not readable
  }
  if (!cmdline) return null;
  const argv = cmdline.split("\0").filter(Boolean);
  if (argv.length === 0) return null;

  const exe = argv[0];
  const looksChrome = /chrom(e|ium)/i.test(exe) || argv.some((a) => a.startsWith("--user-data-dir="));
  if (!looksChrome) return null;
  const userDataDir = argOf(argv, "--user-data-dir");
  if (!userDataDir) return null; // only care about instances we can group/kill
  if (!/chrom(e|ium)/i.test(exe)) return null;

  let ppid = 0;
  let startTicks = 0;
  try {
    const parsed = parseStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
    if (parsed) ({ ppid, startTicks } = parsed);
  } catch {
    /* keep defaults */
  }

  let memMB = 0;
  try {
    const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const residentPages = Number(statm.split(" ")[1]);
    if (Number.isFinite(residentPages)) {
      memMB = (residentPages * PAGE_SIZE) / (1024 * 1024);
    }
  } catch {
    /* leave 0 */
  }

  return {
    pid,
    ppid,
    memMB,
    type: argOf(argv, "--type") ?? "",
    userDataDir,
    startTicks,
    pipe: argv.includes("--remote-debugging-pipe"),
    portArg: argOf(argv, "--remote-debugging-port") === null ? null : Number(argOf(argv, "--remote-debugging-port")),
  };
}

export const NOT_VIEWABLE = {
  pipe: "launched with a pipe (Playwright default), no DevTools port: can't be viewed",
  none: "launched without remote debugging, no DevTools port: can't be viewed",
  unpublished: "DevTools port not published (no DevToolsActivePort yet)",
} as const;

async function parentOf(pid: number): Promise<number> {
  try {
    return parseStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"))?.ppid ?? 0;
  } catch {
    return 0;
  }
}

/** agent-browser's daemons: `~/.agent-browser/<session>.pid` → pid → the session's name. */
export async function agentBrowserSessions(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const dir = path.join(os.homedir(), ".agent-browser");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".pid"));
  } catch {
    return out;
  }
  for (const f of names) {
    try {
      const pid = Number((await fs.readFile(path.join(dir, f), "utf8")).trim());
      if (Number.isInteger(pid) && pid > 1) out.set(pid, f.slice(0, -4));
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/**
 * Who started each root process: walk up its parents to a Claude session in the
 * session registry (its name, as Agents City shows it), to an agent-browser
 * daemon (its --session name; the team uses the agent's name), else to a tmux
 * pane's shell (its session name).
 */
async function ownersOf(rootPids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!rootPids.length) return out;
  const agents = new Map<number, string>();
  try {
    for (const e of (await readRegistry()).entries) if (e.name) agents.set(e.pid, e.name);
  } catch {
    /* no registry */
  }
  const panes = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}"], { timeout: 3000 });
    for (const line of stdout.split("\n")) {
      const [pid, session] = line.split("\t");
      if (pid && session) panes.set(Number(pid), session);
    }
  } catch {
    /* no tmux server */
  }
  const daemons = await agentBrowserSessions();
  for (const root of rootPids) {
    let pid = root;
    for (let i = 0; i < 40 && pid > 1; i++) {
      const name = agents.get(pid) ?? daemons.get(pid) ?? panes.get(pid);
      if (name) { out.set(root, name); break; }
      pid = await parentOf(pid);
    }
  }
  return out;
}

async function systemUptimeSeconds(): Promise<number> {
  try {
    const up = await fs.readFile("/proc/uptime", "utf8");
    return Number(up.split(" ")[0]) || 0;
  } catch {
    return 0;
  }
}

/** All numeric entries under /proc — one per live process. */
async function listPids(): Promise<number[]> {
  const entries = await fs.readdir("/proc");
  const pids: number[] = [];
  for (const e of entries) {
    const n = Number(e);
    if (Number.isInteger(n) && n > 0) pids.push(n);
  }
  return pids;
}

/** Group every Chrome process by its user-data-dir into one row per instance. */
export async function listChromeInstances(): Promise<ChromeInstance[]> {
  const pids = await listPids();
  const uptime = await systemUptimeSeconds();
  const raw = (await Promise.all(pids.map(readProc))).filter(
    (p): p is RawProc => p !== null,
  );

  const byDir = new Map<string, RawProc[]>();
  for (const p of raw) {
    const list = byDir.get(p.userDataDir);
    if (list) list.push(p);
    else byDir.set(p.userDataDir, [p]);
  }

  const instances: ChromeInstance[] = [];
  const roots = [...byDir.values()].map((g) => (g.find((p) => p.type === "") ?? [...g].sort((a, b) => a.pid - b.pid)[0]).pid);
  const owners = await ownersOf(roots);
  for (const [userDataDir, group] of byDir) {
    // Root = the process with no --type= (the browser process). Fall back to
    // the lowest pid if every process somehow has a type.
    const root =
      group.find((p) => p.type === "") ??
      [...group].sort((a, b) => a.pid - b.pid)[0];
    const memMB = group.reduce((s, p) => s + p.memMB, 0);
    const ageSeconds =
      uptime > 0 && root.startTicks > 0
        ? Math.max(0, Math.round(uptime - root.startTicks / CLK_TCK))
        : 0;
    const agentBrowser = userDataDir.startsWith(AGENT_BROWSER_PREFIX);
    const debug = root.portArg !== null && Number.isInteger(root.portArg) && root.portArg >= 0 ? "port" : root.pipe ? "pipe" : "none";
    const port = debug === "port" ? (root.portArg! > 0 ? root.portArg! : await devtoolsPort(userDataDir)) : null;

    instances.push({
      userDataDir,
      label: agentBrowser
        ? userDataDir.slice(AGENT_BROWSER_PREFIX.length)
        : userDataDir.split("/").pop() || userDataDir,
      agentBrowser,
      rootPid: root.pid,
      pids: group.map((p) => p.pid).sort((a, b) => a - b),
      procCount: group.length,
      memMB: Math.round(memMB),
      ageSeconds,
      debug,
      devtoolsPort: port,
      notViewable: debug === "pipe" ? NOT_VIEWABLE.pipe : debug === "none" ? NOT_VIEWABLE.none : port == null ? NOT_VIEWABLE.unpublished : null,
      owner: owners.get(root.pid) ?? null,
    });
  }

  // Heaviest first — the ones worth killing surface at the top.
  instances.sort((a, b) => b.memMB - a.memMB);
  return instances;
}

export type KillSignal = "SIGTERM" | "SIGKILL";

export type KillInstanceResult = {
  userDataDir: string;
  killed: number;
  failed: { pid: number; error: string }[];
};

/** Never signal init, the admin server, or its parent (would kill this app). */
function protectedPids(): Set<number> {
  const guarded = new Set<number>([0, 1, process.pid]);
  if (typeof process.ppid === "number") guarded.add(process.ppid);
  return guarded;
}

/**
 * Kill every process of the instance identified by `userDataDir`. Children
 * (typed processes) are signalled before the root so the browser can't respawn
 * a renderer we've already reaped. We re-scan `/proc` at kill time rather than
 * trusting a pid list from the client, so a stale UID can't target the wrong
 * process after pids are recycled.
 */
export async function killChromeInstance(
  userDataDir: string,
  signal: KillSignal = "SIGTERM",
): Promise<KillInstanceResult> {
  const all = await listChromeInstances();
  const inst = all.find((i) => i.userDataDir === userDataDir);
  const result: KillInstanceResult = { userDataDir, killed: 0, failed: [] };
  if (!inst) return result; // already gone

  const guarded = protectedPids();
  // Root last: it's the process without a --type=, which is inst.rootPid.
  const ordered = [
    ...inst.pids.filter((p) => p !== inst.rootPid),
    inst.rootPid,
  ];

  for (const pid of ordered) {
    if (guarded.has(pid)) {
      result.failed.push({ pid, error: "protected process (refused)" });
      continue;
    }
    try {
      process.kill(pid, signal);
      result.killed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Already dead (often a child that died with its parent) — not a failure.
        continue;
      }
      const msg =
        code === "EPERM"
          ? `not permitted (owned by another user; you run as ${os.userInfo().username})`
          : (err as Error).message;
      result.failed.push({ pid, error: msg });
    }
  }
  return result;
}

/** Kill every Chrome instance (optionally only the agent-browser ones). */
export async function killAllChromeInstances(
  signal: KillSignal = "SIGTERM",
  agentBrowserOnly = false,
): Promise<KillInstanceResult[]> {
  const all = await listChromeInstances();
  const targets = agentBrowserOnly ? all.filter((i) => i.agentBrowser) : all;
  const results: KillInstanceResult[] = [];
  for (const inst of targets) {
    results.push(await killChromeInstance(inst.userDataDir, signal));
  }
  return results;
}

/* --------------------- live view (DevTools / CDP) ----------------------- */
//
// To *see what an instance is looking at* we talk to its DevTools endpoint.
// Chrome is launched with --remote-debugging-port=0, so it picks a random port
// and writes it to `<user-data-dir>/DevToolsActivePort` (line 1). CDP is bound
// to 127.0.0.1, reachable from this server.

export type ChromePage = { id: string; url: string; title: string };

let cache: { at: number; list: Promise<ChromeInstance[]> } | null = null;

/**
 * The live instance with this user-data-dir, or null. Any running instance can
 * be viewed if it has a DevTools port (not only agent-browser ones), so a
 * client-supplied dir is checked against the scan; the scan is shared for a
 * moment so polled frames don't each walk /proc.
 */
export async function findInstance(dir: string): Promise<ChromeInstance | null> {
  if (!cache || Date.now() - cache.at > 2000) cache = { at: Date.now(), list: listChromeInstances() };
  return (await cache.list).find((i) => i.userDataDir === dir) ?? null;
}

/** The instance's DevTools port, or null if it isn't exposing one. */
export async function devtoolsPort(userDataDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(
      path.join(userDataDir, "DevToolsActivePort"),
      "utf8",
    );
    const port = Number(raw.split("\n")[0]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function cdpJson<T>(port: number, endpoint: string): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Real, screenshot-able page targets (excludes chrome:// UI and iframes). */
export async function listChromePages(port: number): Promise<ChromePage[]> {
  const targets =
    (await cdpJson<
      { type: string; id: string; url: string; title: string }[]
    >(port, "/json/list")) ?? [];
  return targets
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.id, url: t.url, title: t.title }));
}

/** The page an instance is "looking at": first non-chrome:// page, else any. */
export function currentPage(pages: ChromePage[]): ChromePage | null {
  return (
    pages.find((p) => !/^(chrome|about|devtools):/.test(p.url)) ??
    pages[0] ??
    null
  );
}

// Screenshots go over the DevTools WebSocket protocol, with Node's own
// WebSocket client: attach to the page's target, ask for one JPEG, detach. The
// browser and its pages are left exactly as they were (nothing is closed or
// navigated). (This used to shell out to a global Playwright, which is no
// longer installed.)
type CdpTarget = { type: string; url: string; webSocketDebuggerUrl?: string };

function cdpScreenshot(wsUrl: string, timeoutMs = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const done = (err: Error | null, buf?: Buffer) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(buf!);
    };
    const timer = setTimeout(() => done(new Error("timed out")), timeoutMs);
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 55 } }));
    ws.onmessage = (ev) => {
      let msg: { id?: number; result?: { data?: string }; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      if (msg.result?.data) done(null, Buffer.from(msg.result.data, "base64"));
      else done(new Error(msg.error?.message ?? "no screenshot"));
    };
    ws.onerror = () => done(new Error("DevTools connection failed"));
  });
}

/** JPEG screenshot of a page on the instance at `port` (defaults to current). */
export async function captureChromePage(
  port: number,
  url?: string,
): Promise<Buffer> {
  const targets = ((await cdpJson<CdpTarget[]>(port, "/json/list")) ?? []).filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl,
  );
  const target =
    (url && targets.find((t) => t.url === url)) ||
    targets.find((t) => !/^(chrome|about|devtools):/.test(t.url)) ||
    targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("no open page");
  return cdpScreenshot(target.webSocketDebuggerUrl);
}
