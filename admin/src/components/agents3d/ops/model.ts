/**
 * What the 2D Ops view shows (T163), from the same timeline and snapshot as the 3D views: each agent's card (what it
 * does, on which file, its task, its last hour), the tasks' bars per agent, the latest messages, and which files are
 * lit (touched lately, held, or claimed twice). Pure, and steady between the clock's ticks: anything that ages is
 * counted on whole steps (10 s, 3 min), so a quiet team gives the same model, and the view draws nothing.
 */
import { fileKey, toolKind, type Snapshot, type Timeline, type ToolKind } from "@/lib/agents3d-timeline";
import type { TaskState, TagName } from "@/lib/claude-comms-parse";
import { doingAt, type Doing, type WaitFor } from "../desk/activity";

/** how long a touched file stays lit */
export const LIT_MS = 5 * 60_000;
/** how long a message shows as an arc */
export const MSG_MS = 2 * 60_000;
/** the cards' activity bars: this many buckets of this long, ending now */
export const SPARK_N = 20;
export const SPARK_MS = 3 * 60_000;
/** the swimlanes' span */
export const LANE_MS = 60 * 60_000;
/** what ages is counted on these steps (ms) */
const STEP = 10_000;
/** a curve from an agent's computer to a file it edited or read fades out over this long (T201) */
export const LINK_MS = 90_000;
/** curves to files an agent holds by CLAIM, at most this many an agent */
const CLAIM_LINKS = 12;
/** commits on the belts: each repo's newest this many (T201; per repo since T204, a belt per city) */
export const BELT_N = 15;

export type LitKind = "edit" | "read" | "held" | "clash";

export type OpsAgent = {
  key: string;
  name: string;
  color: string;
  doing: Doing;
  waitFor: WaitFor | null;
  busy: boolean;
  lastTool: string | null;
  lastKind: ToolKind | null;
  /** the file it works on (fileKey), if laid out */
  focus: string | null;
  /** repo-relative path of what it works on, for the card */
  focusPath: string | null;
  task: { id: string | null; title: string; state: TaskState } | null;
  managing: number;
  /** tool calls per SPARK_MS bucket, oldest first */
  spark: number[];
  /** its bubble (T205): its last steps in words, newest last, each fading with age (1 new … 0.3 old); null when idle */
  bubble: { lines: { kind: "tool" | "say" | "think"; text: string; fade: number }[]; thinking: boolean } | null;
  /** the repo (city) it works in (T204c): of its latest edit, read or claim, a new one only once it has been there
   * CITY_SWITCH_MS; else its working directory's repo */
  city?: string | null;
  /** its last actions, oldest first, for the lines on its screen (T204g): what kind, a size (no text), when */
  acts?: OpsAct[];
  /** the team's manager (T204e): its recipe's manager role, else the one named Alice; sits in a row of its own */
  manager?: boolean;
  /** away from its desk, at the cafeteria's table (T210): idle or napping, nothing done for AWAY_MS; not waiting, not the manager */
  away?: boolean;
};
export type OpsBar = { key: string; id: string | null; title: string; state: TaskState; from: number; to: number | null };
/** a curve from an agent's computer to a file (T201): editing, reading (fading with age, 0..1 on STEP), or claimed */
export type OpsLink = { by: string; file: string; kind: "edit" | "read" | "claim"; fade: number; /** its latest touch (a new one pulses the curve) */ ms: number };
/** a commit on the belt (T201): who made it, where it went, its label (the task id in its subject, else the short hash), pushed yet */
export type OpsCommit = { hash: string; label: string; subject: string; repo: string | null; by: string; ms: number; pushed: boolean };
export type OpsMsg = { id: string; from: string; to: string; tag: TagName | null; color: string; label: string; ms: number; /** 1 new … 0 at MSG_MS old, on STEP (T204e) */ fade: number };
/** an action on an agent's screen (T204g): an edit or write, a read, a command, or another tool; its size (characters
 * written, a command's length; 0 else) */
export type OpsAct = { kind: "edit" | "read" | "bash" | "other"; len: number; ms: number };
export type OpsModel = {
  /** the time shown, on a STEP */
  t: number;
  live: boolean;
  agents: OpsAgent[];
  /** each agent's task bars over the last LANE_MS (as worker) */
  bars: Map<string, OpsBar[]>;
  msgs: OpsMsg[];
  /** fileKey → why it is lit, and by whom (the agent's key, for held files) */
  lit: Map<string, { kind: LitKind; by: string | null }>;
  counts: Record<TaskState, number>;
  links: OpsLink[];
  /** each repo's newest BELT_N commits, oldest first */
  commits: OpsCommit[];
};

const RANK: Record<LitKind, number> = { read: 0, edit: 1, held: 2, clash: 3 };

/** the Ops view's model at the snapshot's time (named agents only, as the Table seats them) */
/** an idle agent goes for a coffee once it has done nothing for this long (T210) */
export const AWAY_MS = 2 * 60_000;

/** the lines an agent's screen shows: its last this many actions (T204g) */
export const SCREEN_N = 6;

/** an agent's last SCREEN_N actions up to `t` (oldest first), from the comms model's (live: its last 12) */
export function actsOf(acts: { kind: OpsAct["kind"]; at: string; len: number }[] | undefined, t: number): OpsAct[] {
  return (acts ?? []).map((x) => ({ kind: x.kind, len: x.len, ms: Date.parse(x.at) })).filter((x) => x.ms <= t + STEP).slice(-SCREEN_N);
}

/** an agent's last tool call at or before `t` (ms; −∞ for none), counted on STEP so it's steady between ticks */
function lastEventAt(events: { ms: number }[], t: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].ms <= t) return Math.floor(events[i].ms / STEP) * STEP;
  return -Infinity;
}

/** an agent's desk moves to a new repo's city only once it has worked there this long (T204c) */
export const CITY_SWITCH_MS = 2 * 60_000;

/**
 * The repo an agent works in at `t` (T204c): its touches (edits, reads, claims) newest first; the latest run in one
 * repo counts once it has lasted CITY_SWITCH_MS (until then, the run before it), so a quick look elsewhere doesn't
 * move its desk; no touches: its working directory's repo.
 */
export function cityOf(touches: { ms: number; repo: string }[], t: number, home: string | null): string | null {
  const ts = touches.filter((x) => x.ms <= t).sort((a, b) => b.ms - a.ms);
  if (!ts.length) return home;
  let i = 0;
  const runs: { repo: string; since: number }[] = [];
  while (i < ts.length && runs.length < 2) {
    const repo = ts[i].repo;
    let since = ts[i].ms;
    while (i < ts.length && ts[i].repo === repo) since = ts[i++].ms;
    runs.push({ repo, since });
  }
  return t - runs[0].since >= CITY_SWITCH_MS || runs.length === 1 ? runs[0].repo : runs[1].repo;
}

/** a bubble shows the last BUBBLE_N steps of the last BUBBLE_MS */
export const BUBBLE_N = 3, BUBBLE_MS = 2 * 60_000;

/** an agent's bubble at `t` (on STEP) from its steps (the comms model's, newest last); null when none is recent */
export function bubbleOf(steps: { t: string; kind: "tool" | "say" | "think"; text: string }[] | undefined, t: number): OpsAgent["bubble"] {
  // (thinking lines only: T205b, the user's choice)
  const recent = (steps ?? []).filter((x) => x.kind === "think").map((x) => ({ ...x, ms: Date.parse(x.t) })).filter((x) => x.ms <= t + STEP && t - x.ms < BUBBLE_MS).slice(-BUBBLE_N);
  if (!recent.length) return null;
  const lines = recent.map((x) => ({ kind: x.kind, text: x.text, fade: Math.round((1 - 0.7 * Math.max(0, t - x.ms) / BUBBLE_MS) * 10) / 10 }));
  return { lines, thinking: recent[recent.length - 1].kind === "think" };
}

export function opsModel(
  tl: Timeline, snap: Snapshot, steps?: Record<string, { t: string; kind: "tool" | "say" | "think"; text: string }[]>,
  acts?: Record<string, { kind: OpsAct["kind"]; at: string; len: number }[]>,
): OpsModel {
  const t = Math.floor(snap.t / STEP) * STEP;
  const lit = new Map<string, { kind: LitKind; by: string | null }>();
  const light = (k: string, kind: LitKind, by: string | null) => {
    const cur = lit.get(k);
    if (!cur || RANK[kind] > RANK[cur.kind]) lit.set(k, { kind, by });
  };
  const agents: OpsAgent[] = [];
  // (each agent's touches for its city: edits and reads in a repo, and its claims)
  const touchesOf = (a: Timeline["agents"][number]) => [
    ...a.events.flatMap((e) => (e.repo && e.path && (toolKind(e.tool) === "edit" || toolKind(e.tool) === "read") ? [{ ms: e.ms, repo: e.repo }] : [])),
    ...tl.claims.flatMap((c) => (c.node === a.key && c.action === "claim" && c.fileKey ? [{ ms: c.ms, repo: c.fileKey.split("\n")[0] }] : [])),
  ];
  const links: OpsLink[] = [];
  const spark0 = Math.floor(snap.t / SPARK_MS) * SPARK_MS - (SPARK_N - 1) * SPARK_MS;
  for (const a of tl.agents) {
    if (a.node.guest) continue;
    const s = snap.agents.get(a.key);
    const d = doingAt(a, snap.t, snap.live);
    const spark = new Array<number>(SPARK_N).fill(0);
    const mine = new Map<string, { kind: "edit" | "read"; ms: number }>();
    for (let i = a.events.length - 1; i >= 0; i--) {
      const e = a.events[i];
      if (e.ms > snap.t) continue;
      if (e.ms < spark0) break;
      spark[Math.floor((e.ms - spark0) / SPARK_MS)]++;
      if (t - e.ms < LIT_MS && e.repo && e.path) {
        const k = toolKind(e.tool), fk = fileKey(e.repo, e.path);
        if ((k === "edit" || k === "read") && tl.files.has(fk)) {
          light(fk, k, a.key);
          // (the curves: the latest touch of each file, an edit over a read, within LINK_MS)
          if (t - e.ms < LINK_MS && !mine.has(fk)) mine.set(fk, { kind: k, ms: e.ms });
          else if (t - e.ms < LINK_MS && k === "edit" && mine.get(fk)?.kind === "read") mine.set(fk, { kind: k, ms: Math.max(e.ms, mine.get(fk)!.ms) });
        }
      }
    }
    for (const [file, l] of mine) links.push({ by: a.key, file, kind: l.kind, fade: Math.round((1 - Math.max(0, t - l.ms) / LINK_MS) * 9) / 9, ms: l.ms });
    agents.push({
      key: a.key,
      name: a.name,
      color: a.color,
      doing: d.doing,
      waitFor: d.waitFor,
      busy: s?.busy ?? false,
      lastTool: s?.lastTool ?? null,
      lastKind: s?.lastTool ? toolKind(s.lastTool) : null,
      focus: s?.focus ?? null,
      focusPath: s?.focus ? s.focus.split("\n")[1] : d.path,
      task: s?.task ? { id: s.task.id, title: s.task.title, state: s.task.state } : null,
      managing: s?.managing ?? 0,
      spark,
      bubble: bubbleOf(steps?.[a.key], t),
      city: cityOf(touchesOf(a), t, a.repo),
      away: (d.doing === "idle" || d.doing === "nap") && t - lastEventAt(a.events, snap.t) >= AWAY_MS,
      acts: actsOf(acts?.[a.key], t),
    });
  }
  // (edits seen on disk, by whoever)
  for (const e of tl.edits) if (e.ms <= snap.t && t - e.ms < LIT_MS && tl.files.has(e.fileKey)) light(e.fileKey, "edit", e.node);
  for (const [k, by] of snap.holders) if (tl.files.has(k)) light(k, by.length > 1 ? "clash" : "held", by[0] ?? null);
  // (claimed files: a curve from each holder, unless it is editing or reading that file now)
  const claimed = new Map<string, number>();
  for (const [k, by] of snap.holders) {
    if (!tl.files.has(k)) continue;
    for (const who of by) {
      if ((claimed.get(who) ?? 0) >= CLAIM_LINKS || links.some((l) => l.by === who && l.file === k)) continue;
      claimed.set(who, (claimed.get(who) ?? 0) + 1);
      links.push({ by: who, file: k, kind: "claim", fade: 1, ms: 0 });
    }
  }

  const bars = new Map<string, OpsBar[]>();
  for (const task of tl.tasks) {
    if (task.guessed) continue;
    const ev = task.events.filter((e) => e.ms <= snap.t);
    if (!ev.length) continue;
    const last = ev[ev.length - 1];
    const end = last.state === "done" || last.state === "cancelled" ? last.ms : null;
    if (end !== null && end < snap.t - LANE_MS) continue;
    const list = bars.get(task.worker) ?? [];
    list.push({ key: task.key, id: task.id, title: task.title, state: last.state, from: ev[0].ms, to: end });
    bars.set(task.worker, list);
  }
  const counts: Record<TaskState, number> = { dispatched: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 };
  for (const x of snap.tasks) if (!x.guessed) counts[x.state]++;
  const msgs = tl.messages
    .filter((m) => m.ms <= snap.t && t - m.ms < MSG_MS)
    .slice(-12)
    .map((m) => ({ id: m.id, from: m.from, to: m.to, tag: m.tag, color: m.color, label: m.label, ms: m.ms, fade: Math.round((1 - Math.max(0, t - m.ms) / MSG_MS) * 9) / 9 }));
  // (the manager: by the recipe's role, else by name)
  const boss = tl.agents.find((a) => !a.node.guest && a.role === "manager")?.key ?? agents.find((a) => /^alice$/i.test(a.name))?.key;
  for (const a of agents) if (a.key === boss) { a.manager = true; a.away = false; }
  const named = new Set(agents.map((a) => a.key));
  // (each repo's newest BELT_N: counted from the newest back)
  const perRepo = new Map<string | null, number>();
  const commits = snap.commits
    .filter((c) => named.has(c.node))
    .reverse()
    .filter((c) => { const n = perRepo.get(c.repo) ?? 0; perRepo.set(c.repo, n + 1); return n < BELT_N; })
    .reverse()
    .map((c) => ({
      hash: c.hash,
      label: /\bT\d+[a-z']*/i.exec(c.subject ?? "")?.[0] ?? c.abbrev,
      subject: c.subject ?? "",
      repo: c.repo,
      by: c.node,
      ms: c.ms,
      pushed: c.remote || (c.pushedMs !== null && c.pushedMs <= snap.t),
    }));
  return { t, live: snap.live, agents, bars, msgs, lit, counts, links, commits };
}

/** a short key of what the lit layer shows: the same key, nothing to draw again */
export const litKey = (lit: OpsModel["lit"]) => [...lit].map(([k, v]) => `${k}=${v.kind}:${v.by ?? ""}`).sort().join("|");
