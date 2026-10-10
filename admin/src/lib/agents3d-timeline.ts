/**
 * Pure time model behind the 3D agents views. `buildTimeline` flattens the
 * data into sorted event lists once per data change; `snapshotAt(tl, T)` says
 * what was true at time T (who was busy, on which file, holding which files,
 * on which task, which commits existed). Live mode is just T = now.
 */
import {
  isClosed,
  type CommitInfo,
  CommsMessage,
  CommsNode,
  CommsRole,
  TagName,
  TaskState,
} from "@/lib/claude-comms-parse";
import type { AgentEvent, Agents3DModel, RepoLayout } from "@/lib/agents3d-types";
import { agentColorMap, NOTE_COLOR, TAG_COLORS } from "@/lib/comms-colors";

/** Colours keyed by node key (named agents fixed, see comms-colors), stable under filters. */
export { agentColorMap } from "@/lib/comms-colors";

export type ToolKind = "edit" | "read" | "run" | "message" | "agent" | "other";
export const TOOL_COLORS: Record<ToolKind, string> = {
  edit: "#f59e0b",
  read: "#38bdf8",
  run: "#a3a3a3",
  message: "#e879f9",
  agent: "#22c55e",
  other: "#64748b",
};
export function toolKind(tool: string): ToolKind {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return "edit";
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/.test(tool)) return "read";
  if (/^(Bash|BashOutput|KillShell|TaskStop)$/.test(tool)) return "run";
  if (/^(SendMessage|ListAgents)$/.test(tool)) return "message";
  if (/^(Agent|Task|Workflow)$/.test(tool)) return "agent";
  return "other";
}

export const TASK_COLORS: Record<TaskState, string> = {
  dispatched: "#3b82f6",
  in_progress: "#f59e0b",
  blocked: "#ef4444",
  done: "#22c55e",
  cancelled: "#6b7280",
};

export type TLAgent = {
  key: string;
  name: string;
  role: CommsRole;
  color: string;
  node: CommsNode;
  repo: string | null;
  /** cwd relative to its repo top ("" at the top). */
  cwdRel: string;
  events: (AgentEvent & { ms: number })[];
};

export type TLMessage = {
  id: string;
  from: string;
  to: string;
  ms: number;
  color: string;
  tag: TagName | null;
  label: string;
};

export type TLClaim = {
  ms: number;
  node: string;
  action: "claim" | "release";
  fileKey: string | null;
  path: string;
  /** From prose, not a CLAIM:/RELEASE: tag: makes a "maybe" holder at most. */
  guessed: boolean;
};
export type TLEdit = { ms: number; fileKey: string; node: string | null };
export type TLCommit = {
  hash: string;
  abbrev: string;
  subject: string | null;
  repo: string | null;
  node: string;
  ms: number;
  pushedMs: number | null;
  remote: boolean;
};
export type TLTaskEvent = { ms: number; key: string; state: TaskState; text: string | null };
export type TLTask = {
  key: string;
  id: string | null;
  title: string;
  manager: string;
  worker: string;
  guessed: boolean;
  events: TLTaskEvent[];
};

export type Timeline = {
  start: number;
  end: number;
  agents: TLAgent[];
  byKey: Map<string, TLAgent>;
  messages: TLMessage[];
  claims: TLClaim[];
  edits: TLEdit[];
  commits: TLCommit[];
  tasks: TLTask[];
  /** `${repo}\n${path}` → true for every laid-out file. */
  files: Set<string>;
  repos: RepoLayout[];
};

export const fileKey = (repo: string, p: string) => `${repo}\n${p}`;

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

function msgLabel(m: CommsMessage): string {
  const t = m.tags[0];
  const head = t ? `${t.tag} ${t.arg.split(/\s+/)[0] ?? ""}`.trim() : "";
  const text = m.summary ?? m.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  return head ? `${head} · ${text}` : text;
}

/** Resolve a claimed path (as written by `node`) to a laid-out file. */
function resolveClaim(
  p: string,
  agent: TLAgent | undefined,
  files: Set<string>,
  byBase: Map<string, string[]>,
): string | null {
  const clean = p.replace(/^\.\//, "").replace(/:\d+$/, "");
  if (agent?.repo) {
    const rel = clean.startsWith("/")
      ? clean.startsWith(`${agent.repo}/`)
        ? clean.slice(agent.repo.length + 1)
        : null
      : agent.cwdRel
        ? `${agent.cwdRel}/${clean}`
        : clean;
    if (rel && files.has(fileKey(agent.repo, rel))) return fileKey(agent.repo, rel);
    if (!clean.startsWith("/") && files.has(fileKey(agent.repo, clean))) return fileKey(agent.repo, clean);
  }
  // Fall back to a unique suffix match ("lane-sketch-sim.ts" → src/lib/lane-sketch-sim.ts).
  const base = clean.split("/").pop()!;
  const cands = (byBase.get(base) ?? []).filter((k) => k.endsWith(`/${clean}`) || k.endsWith(`\n${clean}`));
  const inRepo = agent?.repo ? cands.filter((k) => k.startsWith(`${agent.repo}\n`)) : [];
  if (inRepo.length === 1) return inRepo[0];
  return cands.length === 1 ? cands[0] : null;
}

/**
 * The laid-out repo a commit belongs to: the one it was found in (its top directory, the cities' id); else, for
 * an older cached commit without it, the one of its admin project and app. A repo with no project (/opt/project,
 * a worktree in /tmp) is told apart by its directory only: "no project" isn't a project they share. Null when
 * no laid-out repo is it.
 */
export function repoOfCommit(c: Pick<CommitInfo, "repo" | "project" | "app">, repos: Pick<RepoLayout, "id" | "project" | "app">[]): string | null {
  if (c.repo) return repos.some((r) => r.id === c.repo) ? c.repo : null;
  if (!c.project) return null;
  return repos.find((r) => r.project === c.project && (r.app ?? null) === (c.app ?? null))?.id ?? null;
}

export function buildTimeline(
  model: Pick<Agents3DModel, "comms" | "activity" | "repos" | "nodeRepos">,
  pins: Record<string, CommsRole> = {},
): Timeline {
  const { comms } = model;
  const colors = agentColorMap(comms.nodes);
  const agents: TLAgent[] = comms.nodes.map((n) => {
    const repo = model.nodeRepos[n.key] ?? null;
    const cwdRel = repo && n.cwd && n.cwd.startsWith(repo) ? n.cwd.slice(repo.length).replace(/^\//, "") : "";
    return {
      key: n.key,
      name: n.name,
      role: pins[n.key] ?? n.role,
      color: colors.get(n.key)!,
      node: n,
      repo,
      cwdRel,
      events: (model.activity[n.key] ?? []).map((e) => ({ ...e, ms: Date.parse(e.t) })),
    };
  });
  const byKey = new Map(agents.map((a) => [a.key, a]));

  const files = new Set<string>();
  const byBase = new Map<string, string[]>();
  for (const r of model.repos)
    for (const f of r.files) {
      const k = fileKey(r.id, f.p);
      files.add(k);
      const base = f.p.split("/").pop()!;
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base)!.push(k);
    }

  const messages: TLMessage[] = comms.messages
    .filter((m) => byKey.has(m.from) && byKey.has(m.to))
    .map((m) => {
      const tag = m.tags[0]?.tag ?? null;
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        ms: ms(m.sentAt ?? m.receivedAt),
        color: tag ? TAG_COLORS[tag] : NOTE_COLOR,
        tag,
        label: msgLabel(m),
      };
    })
    .filter((m) => !Number.isNaN(m.ms))
    .sort((a, b) => a.ms - b.ms);

  const claims: TLClaim[] = [];
  for (const f of comms.files)
    for (const h of f.history) {
      const t = ms(h.at);
      if (Number.isNaN(t)) continue;
      claims.push({
        ms: t,
        node: h.node,
        action: h.action,
        guessed: h.guessed,
        path: f.path,
        fileKey: resolveClaim(f.path, byKey.get(h.node), files, byBase),
      });
    }
  claims.sort((a, b) => a.ms - b.ms);

  const edits: TLEdit[] = [];
  for (const a of agents)
    for (const e of a.events)
      if (e.repo && e.path && toolKind(e.tool) === "edit") edits.push({ ms: e.ms, fileKey: fileKey(e.repo, e.path), node: a.key });
  // Uncommitted files' mtimes stand in for edits made through Bash; attributed in snapshotAt.
  for (const r of model.repos)
    for (const d of r.dirty) if (d.m > 0) edits.push({ ms: d.m, fileKey: fileKey(r.id, d.p), node: null });
  edits.sort((a, b) => a.ms - b.ms);

  const commits: TLCommit[] = comms.commits
    .map((c: CommitInfo) => {
      const first = c.mentions.find((m) => m.kind !== "pushed") ?? c.mentions[0];
      const pushed = c.mentions.find((m) => m.kind === "pushed");
      const authored = ms(c.date);
      return {
        hash: c.hash,
        abbrev: c.abbrev,
        subject: c.subject,
        repo: repoOfCommit(c, model.repos),
        node: first.node,
        // Prefer the commit's own date when it's within the window; else when it was first mentioned.
        ms: !Number.isNaN(authored) && authored <= ms(first.at) ? Math.max(authored, ms(first.at) - 3_600_000) : ms(first.at),
        pushedMs: pushed ? ms(pushed.at) : null,
        remote: !!c.remotes?.length,
      };
    })
    .filter((c) => !Number.isNaN(c.ms))
    .sort((a, b) => a.ms - b.ms);

  const tasks: TLTask[] = comms.tasks.map((t) => ({
    key: t.key,
    id: t.id,
    title: t.title,
    manager: t.manager,
    worker: t.worker,
    guessed: t.guessed,
    events: t.history
      .map((h) => ({ ms: ms(h.at), key: t.key, state: h.state, text: h.text }))
      .filter((e) => !Number.isNaN(e.ms)),
  }));

  const allMs = [
    ...messages.map((m) => m.ms),
    ...agents.flatMap((a) => (a.events.length ? [a.events[0].ms] : [])),
  ];
  const now = Date.now();
  const start = allMs.length ? Math.min(...allMs) : now - 3_600_000;
  return { start, end: now, agents, byKey, messages, claims, edits, commits, tasks, files, repos: model.repos };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Activity within this long before T counts as "busy" in replay. */
export const BUSY_MS = 90_000;
/** An agent's focus file is its last file touch within this long. */
export const FOCUS_MS = 15 * 60_000;

export type AgentState = {
  busy: boolean;
  lastTool: string | null;
  focus: string | null; // fileKey
  /** The task it works on: the latest ACKed (in progress or blocked) one not yet done. */
  task: { key: string; id: string | null; title: string; state: TaskState } | null;
  /** Open tasks it has dispatched to others (shown for managers instead of a task). */
  managing: number;
  /** Tool calls in the last 5 minutes before T. */
  rate: number;
};

export type Snapshot = {
  t: number;
  live: boolean;
  agents: Map<string, AgentState>;
  /** fileKey → node keys holding it (two or more = conflict). */
  /** fileKey → agents holding it by CLAIM: tag (two or more = clash). */
  holders: Map<string, string[]>;
  /** fileKey → agents that may hold it (guessed from prose), for files with no tagged holder. */
  maybe: Map<string, string[]>;
  tasks: { key: string; id: string | null; title: string; state: TaskState; manager: string; worker: string; guessed: boolean; since: number }[];
  commits: TLCommit[];
};

export function lastBefore<T extends { ms: number }>(arr: T[], t: number): number {
  // index of the last element with ms <= t, or -1
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ms <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function snapshotAt(tl: Timeline, t: number, live: boolean): Snapshot {
  const tasks: Snapshot["tasks"] = [];
  for (const task of tl.tasks) {
    const i = lastBefore(task.events, t);
    if (i < 0) continue;
    const e = task.events[i];
    tasks.push({ key: task.key, id: task.id, title: task.title, state: e.state, manager: task.manager, worker: task.worker, guessed: task.guessed, since: e.ms });
  }

  const agents = new Map<string, AgentState>();
  for (const a of tl.agents) {
    const i = lastBefore(a.events, t);
    const last = i >= 0 ? a.events[i] : null;
    let focus: string | null = null;
    for (let j = i; j >= 0 && t - a.events[j].ms < FOCUS_MS; j--) {
      const e = a.events[j];
      if (e.repo && e.path && tl.files.has(fileKey(e.repo, e.path))) {
        focus = fileKey(e.repo, e.path);
        break;
      }
    }
    let rate = 0;
    for (let j = i; j >= 0 && t - a.events[j].ms < 5 * 60_000; j--) rate++;
    const recent = !!last && t - last.ms < BUSY_MS;
    const busy = live ? a.node.status === "busy" || recent : recent;
    // Current task: the newest task it works on that it has taken up (ACKed or
    // later) and not finished. Dispatched-but-unacknowledged ones don't count.
    const mine = tasks
      .filter((x) => x.worker === a.key && !x.guessed && (x.state === "in_progress" || x.state === "blocked"))
      .sort((x, y) => y.since - x.since)[0];
    const managing = tasks.filter((x) => x.manager === a.key && !x.guessed && !isClosed(x.state)).length;
    agents.set(a.key, {
      busy,
      lastTool: last?.tool ?? null,
      focus,
      task: mine ? { key: mine.key, id: mine.id, title: mine.title, state: mine.state } : null,
      managing,
      rate,
    });
  }

  // Tagged claims make holders; prose guesses only "maybe" holders. Any release
  // by an agent ends both.
  const held = new Map<string, Set<string>>();
  const guessedHeld = new Map<string, Set<string>>();
  const set = (m: Map<string, Set<string>>, k: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    return s;
  };
  for (let i = 0; i < tl.claims.length && tl.claims[i].ms <= t; i++) {
    const c = tl.claims[i];
    if (!c.fileKey) continue;
    if (c.action === "claim") set(c.guessed ? guessedHeld : held, c.fileKey).add(c.node);
    else {
      set(held, c.fileKey).delete(c.node);
      set(guessedHeld, c.fileKey).delete(c.node);
    }
  }
  const holders = new Map<string, string[]>();
  for (const [k, s] of held) if (s.size) holders.set(k, [...s]);
  const maybe = new Map<string, string[]>();
  for (const [k, s] of guessedHeld) if (s.size && !holders.has(k)) maybe.set(k, [...s]);

  const commits = tl.commits.filter((c) => c.ms <= t);
  return { t, live, agents, holders, maybe, tasks, commits };
}

/** Who most likely made an unattributed edit: the file's holder, else a busy agent in that repo. */
export function editor(tl: Timeline, snap: Snapshot, e: TLEdit): string | null {
  if (e.node) return e.node;
  const h = snap.holders.get(e.fileKey);
  if (h?.length) return h[0];
  const repo = e.fileKey.split("\n")[0];
  const cands = tl.agents.filter((a) => a.repo === repo && a.events.some((x) => Math.abs(x.ms - e.ms) < BUSY_MS));
  return cands.length === 1 ? cands[0].key : null;
}

/** Agent with the most tool calls in the last 5 minutes. */
export function busiest(snap: Snapshot): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [k, s] of snap.agents)
    if (s.rate > n) {
      n = s.rate;
      best = k;
    }
  return best;
}

// ── Projects (filter) ────────────────────────────────────────────────────────

export type ProjectInfo = { id: string; name: string; agents: number; activity: number };

/** An agent's project: its repo's top dir, else its cwd. */
export function projectOf(a: TLAgent): string {
  return a.repo ?? a.node.cwd ?? "(no directory)";
}

/** Every project with agents or laid-out files in the timeline, busiest first. */
export function listProjects(tl: Timeline): ProjectInfo[] {
  const out = new Map<string, ProjectInfo>();
  const get = (id: string) => {
    let p = out.get(id);
    if (!p) {
      const repo = tl.repos.find((r) => r.id === id);
      p = { id, name: repo?.name ?? (id.split("/").filter(Boolean).pop() || id), agents: 0, activity: 0 };
      out.set(id, p);
    }
    return p;
  };
  for (const r of tl.repos) get(r.id);
  for (const a of tl.agents) {
    const p = get(projectOf(a));
    p.agents++;
    p.activity += a.events.length;
  }
  return [...out.values()].sort((x, y) => y.agents - x.agents || y.activity - x.activity || x.name.localeCompare(y.name));
}

/**
 * The timeline without the hidden projects: their agents, their cities, and
 * every message, claim, edit and commit touching them. Messages between a
 * shown and a hidden agent are dropped too (counted in `hiddenMessages`).
 */
export function filterTimeline(tl: Timeline, hidden: Set<string>): Timeline & { hiddenMessages: number } {
  if (hidden.size === 0) return { ...tl, hiddenMessages: 0 };
  const agents = tl.agents.filter((a) => !hidden.has(projectOf(a)));
  const keep = new Set(agents.map((a) => a.key));
  const repoOk = (fk: string | null) => !fk || !hidden.has(fk.split("\n")[0]);
  const messages = tl.messages.filter((m) => keep.has(m.from) && keep.has(m.to));
  const files = new Set([...tl.files].filter((k) => repoOk(k)));
  return {
    ...tl,
    agents,
    byKey: new Map(agents.map((a) => [a.key, a])),
    messages,
    hiddenMessages: tl.messages.filter((m) => keep.has(m.from) !== keep.has(m.to)).length,
    claims: tl.claims.filter((c) => keep.has(c.node) && repoOk(c.fileKey)),
    edits: tl.edits.filter((e) => repoOk(e.fileKey) && (!e.node || keep.has(e.node))),
    commits: tl.commits.filter((c) => keep.has(c.node) && (!c.repo || !hidden.has(c.repo))),
    tasks: tl.tasks.filter((t) => keep.has(t.manager) || keep.has(t.worker)),
    files,
    repos: tl.repos.filter((r) => !hidden.has(r.id)),
  };
}
