// Pure (tested): how hard a delegated agent thinks, as picked in a task's right-click menu (task-board.tsx). An agent
// already running gets it as `/effort <level>` before its brief, a new one as `claude --effort <level>`
// (task-delegate.ts).

/** Claude Code's effort levels, least to most (xhigh and max where the model has them). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/** The line a delegation leaves in the ticket's thread: to whom, how (a fresh context, an effort) and the note. */
export function delegationLine(assignee: string, o: { fresh?: boolean; effort?: Effort | null; note?: string | null } = {}): string {
  const how = [o.fresh ? "fresh context" : null, o.effort ? `${o.effort} effort` : null].filter(Boolean);
  return `Delegated to ${assignee}${how.length ? ` (${how.join(", ")})` : ""}${o.note ? `: ${o.note}` : ""}`;
}

/** Where Claude Code keeps a default effort for new sessions, in its user settings. */
const EFFORT_KEYS = ["effortLevel", "modelSettings"] as const;

/**
 * Claude's user settings after `/effort` (`after`), with the default effort they held before (`before`) put back:
 * /effort saves low…xhigh as the default for every new session, and a delegation means it for its one agent. Only
 * those keys go back; anything else changed meanwhile stays. null: nothing to put back, or a file that isn't settings.
 */
export function restoreEffortDefault(before: string | null, after: string | null): string | null {
  const parse = (t: string | null): Record<string, unknown> | null => {
    if (t === null || !t.trim()) return {};
    try {
      const o = JSON.parse(t);
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  };
  const was = parse(before);
  const now = parse(after);
  if (!was || !now) return null;
  const out: Record<string, unknown> = { ...now };
  let changed = false;
  for (const k of EFFORT_KEYS) {
    if (JSON.stringify(now[k]) === JSON.stringify(was[k])) continue;
    changed = true;
    if (was[k] === undefined) delete out[k];
    else out[k] = was[k];
  }
  return changed ? `${JSON.stringify(out, null, 2)}\n` : null;
}
