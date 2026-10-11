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
};
export type OpsBar = { key: string; id: string | null; title: string; state: TaskState; from: number; to: number | null };
/** a curve from an agent's computer to a file (T201): editing, reading (fading with age, 0..1 on STEP), or claimed */
export type OpsLink = { by: string; file: string; kind: "edit" | "read" | "claim"; fade: number; /** its latest touch (a new one pulses the curve) */ ms: number };
/** a commit on the belt (T201): who made it, where it went, its label (the task id in its subject, else the short hash), pushed yet */
export type OpsCommit = { hash: string; label: string; subject: string; repo: string | null; by: string; ms: number; pushed: boolean };
export type OpsMsg = { id: string; from: string; to: string; tag: TagName | null; color: string; label: string; ms: number };
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
/** a bubble shows the last BUBBLE_N steps of the last BUBBLE_MS */
export const BUBBLE_N = 3, BUBBLE_MS = 2 * 60_000;

/** an agent's bubble at `t` (on STEP) from its steps (the comms model's, newest last); null when none is recent */
export function bubbleOf(steps: { t: string; kind: "tool" | "say" | "think"; text: string }[] | undefined, t: number): OpsAgent["bubble"] {
  const recent = (steps ?? []).map((x) => ({ ...x, ms: Date.parse(x.t) })).filter((x) => x.ms <= t + STEP && t - x.ms < BUBBLE_MS).slice(-BUBBLE_N);
  if (!recent.length) return null;
  const lines = recent.map((x) => ({ kind: x.kind, text: x.text, fade: Math.round((1 - 0.7 * Math.max(0, t - x.ms) / BUBBLE_MS) * 10) / 10 }));
  return { lines, thinking: recent[recent.length - 1].kind === "think" };
}

export function opsModel(tl: Timeline, snap: Snapshot, steps?: Record<string, { t: string; kind: "tool" | "say" | "think"; text: string }[]>): OpsModel {
  const t = Math.floor(snap.t / STEP) * STEP;
  const lit = new Map<string, { kind: LitKind; by: string | null }>();
  const light = (k: string, kind: LitKind, by: string | null) => {
    const cur = lit.get(k);
    if (!cur || RANK[kind] > RANK[cur.kind]) lit.set(k, { kind, by });
  };
  const agents: OpsAgent[] = [];
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
    .slice(-6)
    .map((m) => ({ id: m.id, from: m.from, to: m.to, tag: m.tag, color: m.color, label: m.label, ms: m.ms }));
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
