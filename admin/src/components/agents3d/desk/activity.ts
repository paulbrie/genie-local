/**
 * Pure activity model for the Desk: what each agent is acting out at time T.
 *
 * Two layers:
 * - a continuous "doing" (typing, reading, running, thinking, idle, napping),
 *   the dominant tool kind over the last minute, so bursts don't flicker;
 * - one-shot "beats" (carry a message, plant/pull a flag, stack a commit, wave at
 *   origin, cheer, blocked), each lasting a fixed real time. Beats are scheduled
 *   per agent as a queue in timeline time: one starts when its event happens or
 *   when the previous one ends; same-kind beats arriving during one merge into it
 *   (count++), and anything more than a few beats behind is dropped. Pure in
 *   (timeline, speed), so scrubbing anywhere gives the same picture.
 */
import { lastBefore, type Timeline, type TLAgent, toolKind } from "@/lib/agents3d-timeline";
import { TAG_COLORS } from "@/lib/comms-colors";

export type BeatKind = "carry" | "plant" | "unplant" | "stack" | "wave" | "cheer" | "blocked";
export type Beat = {
  kind: BeatKind;
  id: string;
  /** When it was due (event time, or first seen in live mode). */
  at: number;
  start: number;
  end: number;
  color: string;
  peer?: string;
  fileKey?: string | null;
  label: string;
  count: number;
};

/** Real ms each beat plays for (scaled by the replay speed into timeline ms). */
export const BEAT_MS: Record<BeatKind, number> = {
  carry: 4500,
  plant: 3200,
  unplant: 2200,
  stack: 3200,
  wave: 3000,
  cheer: 2400,
  blocked: 4000,
};
const MAX_BACKLOG = 3;

type Raw = Omit<Beat, "start" | "end" | "count" | "at"> & { ms: number };

const SKIP_CARRY = new Set(["CLAIM", "RELEASE", "COMMIT", "PUSHED"]);

/** Every one-shot event per agent, unscheduled. Depends only on the timeline. */
export function rawBeats(tl: Timeline): Map<string, Raw[]> {
  const out = new Map<string, Raw[]>();
  const add = (key: string, r: Raw) => {
    if (!tl.byKey.has(key)) return;
    const list = out.get(key) ?? [];
    list.push(r);
    out.set(key, list);
  };
  const name = (k: string) => tl.byKey.get(k)?.name ?? k;
  for (const m of tl.messages)
    if (!m.tag || !SKIP_CARRY.has(m.tag))
      add(m.from, { kind: "carry", id: `m:${m.id}`, ms: m.ms, color: m.color, peer: m.to, label: `${m.tag ?? "note"} → ${name(m.to)}` });
  for (const c of tl.claims)
    if (!c.guessed && c.fileKey)
      add(c.node, {
        kind: c.action === "claim" ? "plant" : "unplant",
        id: `c:${c.node}:${c.ms}:${c.path}`,
        ms: c.ms,
        color: c.action === "claim" ? TAG_COLORS.CLAIM : TAG_COLORS.RELEASE,
        fileKey: c.fileKey,
        label: `${c.action === "claim" ? "claims" : "releases"} ${c.path.split("/").pop()}`,
      });
  for (const c of tl.commits) {
    add(c.node, { kind: "stack", id: `k:${c.hash}`, ms: c.ms, color: TAG_COLORS.COMMIT, label: `commit ${c.abbrev}` });
    if (c.pushedMs != null) add(c.node, { kind: "wave", id: `p:${c.hash}`, ms: c.pushedMs, color: TAG_COLORS.PUSHED, label: "pushed to origin" });
  }
  for (const task of tl.tasks)
    for (const e of task.events) {
      if (e.state === "done") add(task.worker, { kind: "cheer", id: `d:${task.key}:${e.ms}`, ms: e.ms, color: TAG_COLORS.DONE, label: `done ${task.id ?? ""}`.trim() });
      if (e.state === "blocked") add(task.worker, { kind: "blocked", id: `b:${task.key}:${e.ms}`, ms: e.ms, color: TAG_COLORS.BLOCKED, label: `blocked ${task.id ?? ""}`.trim() });
    }
  return out;
}

/**
 * Queue one agent's beats. `scale` = timeline ms per real ms (1 live, the
 * replay speed otherwise); `eff` maps an event to when its beat is due.
 */
export function scheduleBeats(raw: Raw[], scale: number, eff: (id: string, ms: number) => number): Beat[] {
  const due = raw.map((r) => ({ r, at: eff(r.id, r.ms) })).sort((a, b) => a.at - b.at);
  const out: Beat[] = [];
  for (const { r, at } of due) {
    const dur = BEAT_MS[r.kind] * scale;
    const prev = out[out.length - 1];
    if (prev && prev.kind === r.kind && prev.peer === r.peer && at <= prev.end) {
      prev.count++;
      prev.label = r.label;
      prev.fileKey = r.fileKey ?? prev.fileKey;
      continue;
    }
    const start = Math.max(at, prev?.end ?? -Infinity);
    if (start - at > MAX_BACKLOG * dur) continue; // too far behind: the scene's state still shows it
    out.push({ kind: r.kind, id: r.id, color: r.color, peer: r.peer, fileKey: r.fileKey, label: r.label, at, start, end: start + dur, count: 1 });
  }
  return out;
}

/** The beat playing at t, if any, with its progress 0..1. */
export function beatAt(beats: Beat[], t: number): { beat: Beat; k: number } | null {
  let lo = 0;
  let hi = beats.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].start <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const b = beats[i];
  return b && t < b.end ? { beat: b, k: (t - b.start) / (b.end - b.start) } : null;
}

export type Doing = "type" | "read" | "run" | "think" | "idle" | "nap";

/** Tool activity within this window decides what an agent is doing. */
const WINDOW_MS = 60_000;
/** No tool call for this long: idle; longer than NAP_MS: napping. */
const IDLE_MS = 90_000;
const NAP_MS = 5 * 60_000;

/** The continuous activity at t: the dominant tool kind over the last minute. */
export function doingAt(a: TLAgent, t: number, live: boolean): { doing: Doing; tool: string | null; repo: string | null; path: string | null } {
  const i = lastBefore(a.events, t);
  const last = i >= 0 ? a.events[i] : null;
  const since = last ? t - last.ms : Infinity;
  if (since > IDLE_MS) {
    if (live && a.node.status === "busy") return { doing: "think", tool: null, repo: null, path: null };
    return { doing: since > NAP_MS ? "nap" : "idle", tool: null, repo: null, path: null };
  }
  const score = { type: 0, read: 0, run: 0, think: 0 };
  let repo: string | null = null;
  let path: string | null = null;
  for (let j = i; j >= 0 && t - a.events[j].ms < WINDOW_MS; j--) {
    const e = a.events[j];
    const k = toolKind(e.tool);
    // Recent calls count more, so a switch shows within seconds, not a minute.
    const w = 1 + (WINDOW_MS - (t - e.ms)) / WINDOW_MS;
    if (k === "edit") score.type += w * 1.5;
    else if (k === "read") score.read += w;
    else if (k === "run") score.run += w;
    else score.think += w * 0.5;
    if (!path && e.path && (k === "edit" || k === "read")) {
      path = e.path;
      repo = e.repo;
    }
  }
  const doing = (Object.keys(score) as (keyof typeof score)[]).reduce((x, y) => (score[y] > score[x] ? y : x), "think");
  return { doing: score[doing] > 0 ? doing : "think", tool: last?.tool ?? null, repo, path };
}
