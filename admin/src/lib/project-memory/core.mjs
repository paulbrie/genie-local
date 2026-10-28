// What each project under PROJECTS_ROOT has in memory right now: every process whose working directory is inside a
// project (so a dev server, a second `npm run`, a test runner, its Playwright browsers… whoever started them), grouped
// by process group (one script and its children), plus the project's Docker containers. Kept as plain Node ESM with
// built-ins only, so both the app (src/lib/project-memory) and the per-minute history cron
// (scripts/stats-history.mjs) use the same numbers.
//
// Memory is PSS (each process's share of the pages it shares, from /proc/<pid>/smaps_rollup), so the workers of one
// Next server, which share most of their memory, add up to what's really in use; RSS where PSS can't be read.
// Claude sessions run in project folders too: they're counted apart, as the project's agents.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const PAGE = 4096;

/** A process's stat fields after the comm: [state, ppid, pgrp, …, rss (pages) at 21]. */
async function readStat(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const comm = raw.slice(raw.indexOf("(") + 1, close);
    const f = raw.slice(close + 2).split(" ");
    // starttime (field 22) is in clock ticks since boot: 100 a second on Linux
    return { comm, ppid: Number(f[1]), pgid: Number(f[2]), rss: Number(f[21]) * PAGE, startTicks: Number(f[19]) };
  } catch {
    return null;
  }
}

async function readPss(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = /^Pss:\s+(\d+) kB/m.exec(raw);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function readCmd(pid) {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** A short name for a command line: "npm run dev", "next dev", "node server.mjs", "chrome"… */
export function commandLabel(argv, comm) {
  if (!argv.length) return comm;
  const base = (s) => path.basename(s);
  let [a0, ...rest] = argv;
  // node / npx / tsx running a script: name the script, not the interpreter
  if (/^(node|nodejs|bun|deno|python3?)$/.test(base(a0)) && rest.length) {
    const i = rest.findIndex((x) => !x.startsWith("-"));
    if (i >= 0) {
      const script = rest[i];
      const after = rest.slice(i + 1).filter((x) => !x.startsWith("-"));
      // node_modules/.bin/next dev → "next dev"; npm-cli.js run dev → "npm run dev"
      if (/npm-cli\.js$/.test(script)) return ["npm", ...after.slice(0, 2)].join(" ");
      if (script.includes("node_modules/")) return [base(script).replace(/\.(c|m)?js$/, ""), ...after.slice(0, 1)].join(" ");
      return [base(a0), base(script), ...after.slice(0, 1)].join(" ");
    }
  }
  if (base(a0) === "npm" || base(a0) === "pnpm" || base(a0) === "yarn") return [base(a0), ...rest.slice(0, 2)].join(" ");
  if (/chrom/i.test(base(a0))) return "chrome";
  if (/^(sh|bash|zsh)$/.test(base(a0)) && rest[0] === "-c" && rest[1]) {
    // a Claude tool shell wraps the command: "source <snapshot> … && eval '<command>' && pwd -P …"
    const evald = /&& eval '(.*?)'(?: && pwd -P|$)/s.exec(rest[1]);
    return (evald ? evald[1].replace(/'"'"'/g, "'") : rest[1]).trim().split(/\s+/).slice(0, 3).join(" ").slice(0, 40);
  }
  return [base(a0), ...rest.filter((x) => !x.startsWith("-")).slice(0, 1).map(base)].join(" ");
}

/** The runner's pid files: pgid (= the pid it started, detached) → run slug ("acccess-dev"). */
async function runnerGroups(runDir) {
  const out = new Map();
  let names = [];
  try {
    names = await fs.readdir(runDir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => n.endsWith(".pid"))
      .map(async (n) => {
        const pid = parseInt(await fs.readFile(path.join(runDir, n), "utf8").catch(() => ""), 10);
        if (pid > 0) out.set(pid, n.slice(0, -4));
      }),
  );
  return out;
}

const run = (cmd, args, timeout = 8000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)));

/** "12.3MiB / 7.6GiB" → bytes of the used side. */
function dockerBytes(s) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(s.trim());
  if (!m) return 0;
  const mult = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  return parseFloat(m[1]) * (mult[(m[2] || "B").toLowerCase()] ?? 1);
}

/** Running containers whose compose project lives in a project folder: { project, name, bytes }. */
export async function projectContainers(root) {
  const [ps, stats] = await Promise.all([
    run("docker", ["ps", "--format", '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}']),
    run("docker", ["stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}"], 15000),
  ]);
  if (!ps || !stats) return [];
  const mem = new Map(stats.split("\n").filter(Boolean).map((l) => l.split("\t")).map(([id, m]) => [id.slice(0, 12), dockerBytes(m ?? "")]));
  const out = [];
  for (const line of ps.split("\n").filter(Boolean)) {
    const [id, name, dir] = line.split("\t");
    if (!dir || !dir.startsWith(`${root}/`)) continue;
    out.push({ project: dir.slice(root.length + 1).split("/")[0], name, bytes: mem.get(id.slice(0, 12)) ?? 0 });
  }
  return out;
}

/**
 * Memory per project. `containers` (from projectContainers) is passed in so a caller can refresh the slow
 * `docker stats` less often than the processes.
 *
 * Returns { ts, projects: [{ slug, bytes, agentBytes, groups: [{ key, label, kind, app, script, pids, bytes, estimated }] }] },
 * projects and groups biggest first. `bytes` leaves the agents out; `estimated` = some of it is RSS, not PSS.
 */
/** When the system booted (ms), for processes' start times. */
async function bootTime() {
  try {
    const m = /^btime (\d+)/m.exec(await fs.readFile("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

export async function measureProjects({ root, runDir, containers = [] }) {
  const [runs, boot] = await Promise.all([runnerGroups(runDir), bootTime()]);
  let names = [];
  try {
    names = await fs.readdir("/proc");
  } catch {
    /* no /proc: nothing to say */
  }
  const prefix = `${root}/`;
  const found = [];
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        let cwd;
        try {
          cwd = await fs.readlink(`/proc/${n}/cwd`);
        } catch {
          return; // gone, or someone else's
        }
        if (!cwd.startsWith(prefix)) return;
        const st = await readStat(n);
        if (!st || st.rss === 0) return; // kernel threads, zombies
        const rel = cwd.slice(prefix.length).split("/");
        found.push({ pid: Number(n), cwd, project: rel[0], sub: rel[1] ?? "", ...st });
      }),
  );

  // per process: its share (PSS) and how it reads
  await Promise.all(
    found.map(async (p) => {
      const pss = await readPss(p.pid);
      p.bytes = pss ?? p.rss;
      p.estimated = pss == null;
      p.argv = await readCmd(p.pid);
    }),
  );
  const byPid = new Map(found.map((p) => [p.pid, p]));

  const projects = new Map();
  const project = (slug) => {
    if (!projects.has(slug)) projects.set(slug, { slug, bytes: 0, agentBytes: 0, groups: new Map() });
    return projects.get(slug);
  };
  const isClaude = (p) => !!p && (/^claude/i.test(p.comm) || p.argv.some((a) => /(^|\/)claude(\.exe)?$/.test(a)));
  const isShell = (p) => !p || /^(sh|bash|zsh|dash)$/.test(p.comm);
  // one Claude session, one row: a session's processes can sit in several groups (a background session's host and
  // its client), so an agent is filed under its topmost Claude ancestor in the project
  const agentRoot = (p) => {
    let q = p;
    for (let hops = 0; hops < 16 && isClaude(byPid.get(q.ppid)); hops++) q = byPid.get(q.ppid);
    return q.pid;
  };
  for (const p of found) {
    const leader = byPid.get(p.pgid);
    // a Claude session, and what runs in its own group (its MCP servers…); what it runs through a shell of its own is
    // the project's (a dev server, tests) and counts as such
    const isAgent = isClaude(p) || isClaude(leader);
    const slug = runs.get(p.pgid);
    const key = isAgent ? `agent:${agentRoot(leader ?? p)}` : `pg:${p.pgid}`;
    const proj = project(p.project);
    let g = proj.groups.get(key);
    if (!g) {
      const script = slug && slug.startsWith(`${p.project}-`) ? slug.slice(p.project.length + 1) : slug ?? null;
      g = { key, label: "", kind: isAgent ? "agent" : slug ? "script" : "process", app: p.sub, script, pids: [], procs: [], bytes: 0, estimated: false, members: [] };
      proj.groups.set(key, g);
    }
    g.members.push(p);
    g.pids.push(p.pid);
    g.procs.push({
      pid: p.pid,
      ppid: p.ppid,
      command: (p.argv.length ? p.argv.join(" ") : p.comm).slice(0, 300),
      cwd: p.cwd,
      bytes: p.bytes,
      estimated: p.estimated,
      startedAt: boot != null ? boot + p.startTicks * 10 : null,
    });
    g.bytes += p.bytes;
    g.estimated ||= p.estimated;
    if (isAgent) proj.agentBytes += p.bytes;
    else proj.bytes += p.bytes;
  }
  // names: the script; else the group's leader, or its biggest process when the leader is only a shell
  for (const proj of projects.values())
    for (const g of proj.groups.values()) {
      const leader = byPid.get(g.members[0].pgid);
      const named = g.kind === "agent" ? null : isShell(leader) ? g.members.reduce((x, y) => (y.bytes > x.bytes ? y : x)) : leader;
      g.label = g.kind === "agent" ? "claude" : (g.script ?? commandLabel(named.argv, named.comm));
      delete g.members;
      g.procs.sort((a, b) => b.bytes - a.bytes);
    }
  for (const c of containers) {
    const proj = project(c.project);
    proj.groups.set(`docker:${c.name}`, { key: `docker:${c.name}`, label: c.name, kind: "container", app: "", script: null, pids: [], procs: [], bytes: c.bytes, estimated: false });
    proj.bytes += c.bytes;
  }

  return {
    ts: Date.now(),
    projects: [...projects.values()]
      .map((p) => ({ ...p, groups: [...p.groups.values()].sort((a, b) => b.bytes - a.bytes) }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}
