import { findHashes, type CommitInfo, type CommsMessage, type CommsModel, type CommsTask, type FileClaim, type TaskState } from "@/lib/claude-comms-parse";

/**
 * The Tasks board's view of the comms model: tasks in columns by state, their
 * timings (since the ACK, how long a done one took), latest STATUS line, and a
 * task's thread (its messages, commits and claims). Pure, so it is tested.
 */

export type ColumnId = "todo" | "doing" | "blocked" | "done" | "cancelled";

export const COLUMNS: { id: ColumnId; title: string; states: TaskState[] }[] = [
  { id: "todo", title: "To do", states: ["dispatched"] },
  { id: "doing", title: "Doing", states: ["in_progress"] },
  { id: "blocked", title: "Blocked", states: ["blocked"] },
  { id: "done", title: "Done", states: ["done"] },
  { id: "cancelled", title: "Cancelled", states: ["cancelled"] },
];

export const columnOf = (s: TaskState): ColumnId => COLUMNS.find((c) => c.states.includes(s))!.id;

export type BoardModel = Pick<CommsModel, "nodes" | "messages" | "tasks" | "files" | "commits"> & {
  /** Session key → its project (repo top dir) and the project's name. */
  projects: Record<string, { id: string; name: string }>;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** When the owner took it (its first ACK / STATUS), or null. */
export function ackedAt(t: CommsTask): string | null {
  return t.history.find((h) => h.state === "in_progress")?.at ?? null;
}

/** When it was closed (done / cancelled), or null while open. */
export function closedAt(t: CommsTask): string | null {
  if (t.state !== "done" && t.state !== "cancelled") return null;
  for (let i = t.history.length - 1; i >= 0; i--) if (t.history[i].state === t.state) return t.history[i].at;
  return t.updatedAt;
}

/** "12 min", "3 h 05 min", "2 d 4 h" */
export function fmtSpan(msSpan: number): string {
  const m = Math.max(0, Math.round(msSpan / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** The card's time: Doing "for N" since the ACK, Done "took N" (from the ACK, else from the TASK), else the age. */
export function elapsed(t: CommsTask, now: number): string | null {
  const ack = ms(ackedAt(t)), created = ms(t.createdAt), closed = ms(closedAt(t));
  if (t.state === "done") {
    const from = Number.isFinite(ack) ? ack : created;
    return Number.isFinite(from) && Number.isFinite(closed) ? `took ${fmtSpan(closed - from)}` : null;
  }
  if (t.state === "cancelled") return Number.isFinite(closed) ? `cancelled ${fmtSpan(now - closed)} ago` : null;
  if (t.state === "in_progress" && Number.isFinite(ack)) return `for ${fmtSpan(now - ack)}`;
  return Number.isFinite(created) ? `${fmtSpan(now - created)} ago` : null;
}

/** The latest STATUS line (its first line), from the task's own messages. */
export function latestStatus(t: CommsTask, byId: Map<string, CommsMessage>): string | null {
  for (let i = t.history.length - 1; i >= 0; i--) {
    const h = t.history[i], m = byId.get(h.msgId);
    if (!m) continue;
    const tag = m.tags.find((x) => x.tag === "STATUS" && (!t.id || x.arg.toUpperCase().startsWith(t.id)));
    if (tag) {
      const text = (h.text ?? tag.arg.slice(t.id?.length ?? 0)).trim();
      return text.split("\n")[0] || null;
    }
  }
  return null;
}

/** The task's owner (the worker) and its project. */
export function ownerOf(t: CommsTask, model: BoardModel) {
  const node = model.nodes.find((n) => n.key === t.worker);
  const project = model.projects[t.worker] ?? model.projects[t.manager] ?? null;
  return { key: t.worker, name: node?.name ?? t.worker, project };
}

export type BoardFilter = { project: string | null; owner: string | null; search: string };

export function matches(t: CommsTask, model: BoardModel, f: BoardFilter): boolean {
  const o = ownerOf(t, model);
  if (f.project && o.project?.id !== f.project) return false;
  if (f.owner && o.key !== f.owner) return false;
  const q = f.search.trim().toLowerCase();
  if (q && !`${t.id ?? ""} ${t.title} ${t.lastText ?? ""}`.toLowerCase().includes(q)) return false;
  return true;
}

/** Tasks per column, filtered: open ones newest activity first, Done / Cancelled by when they closed, newest first. */
export function board(model: BoardModel, f: BoardFilter): Record<ColumnId, CommsTask[]> {
  const out = { todo: [], doing: [], blocked: [], done: [], cancelled: [] } as Record<ColumnId, CommsTask[]>;
  for (const t of model.tasks) if (matches(t, model, f)) out[columnOf(t.state)].push(t);
  const by = (when: (t: CommsTask) => string | null) => (a: CommsTask, b: CommsTask) =>
    (ms(when(b)) || 0) - (ms(when(a)) || 0);
  for (const c of ["todo", "doing", "blocked"] as const) out[c].sort(by((t) => t.updatedAt));
  out.done.sort(by(closedAt));
  out.cancelled.sort(by(closedAt));
  return out;
}

const ID_WORD = (id: string) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i");

/**
 * A task's thread: its own messages (TASK / ACK / STATUS / BLOCKED / DONE /
 * CANCELLED) and any other that names it, oldest first; the commits mentioned
 * in them; and the files its owner claimed while it was open (or in them).
 */
export function threadOf(t: CommsTask, model: BoardModel, now: number) {
  const own = new Set(t.history.map((h) => h.msgId));
  const re = t.id ? ID_WORD(t.id) : null;
  const messages = model.messages
    .filter((m) => own.has(m.id) || (re && (re.test(m.summary ?? "") || re.test(m.body))))
    .sort((a, b) => (ms(a.sentAt ?? a.receivedAt) || 0) - (ms(b.sentAt ?? b.receivedAt) || 0));
  const ids = new Set(messages.map((m) => m.id));
  // (a mention may be recorded under the other side's copy of a message, so the hashes written in them count too)
  const written = messages.flatMap((m) => findHashes(m.body));
  const commits: CommitInfo[] = model.commits.filter(
    (c) => c.mentions.some((x) => ids.has(x.msgId)) || written.some((h) => c.hash.startsWith(h) || h.startsWith(c.abbrev)),
  );
  const from = ms(t.createdAt), to = ms(closedAt(t)) || now;
  const claims: { file: FileClaim; at: string | null; action: "claim" | "release" }[] = [];
  for (const f of model.files)
    for (const h of f.history) {
      const at = ms(h.at);
      if (ids.has(h.msgId) || (h.node === t.worker && Number.isFinite(at) && at >= from && at <= to))
        claims.push({ file: f, at: h.at, action: h.action });
    }
  return { messages, commits, claims };
}
