// Pure (tested): how a delegated agent works, as picked in a task's right-click menu (task-board.tsx): its model and
// how hard it thinks. A new agent starts with them (`claude --model … --effort …`, its session only); an agent already
// running gets `/model` and `/effort` before its brief (task-delegate.ts), which Claude also saves as the default for
// every new session, so the default the user's settings held is put back (restoreDefaults).

/** Claude Code's model families, by their aliases (the CLI resolves each to its latest). */
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export const MODEL_LABEL: Record<Model, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

export const isModel = (v: unknown): v is Model => typeof v === "string" && (MODELS as readonly string[]).includes(v);

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

/** The line a delegation leaves in the ticket's thread: to whom, how (a fresh context, a model, an effort), the note. */
export function delegationLine(
  assignee: string,
  o: { fresh?: boolean; model?: Model | null; effort?: Effort | null; note?: string | null } = {},
): string {
  const how = [o.fresh ? "fresh context" : null, o.model ?? null, o.effort ? `${o.effort} effort` : null].filter(Boolean);
  return `Delegated to ${assignee}${how.length ? ` (${how.join(", ")})` : ""}${o.note ? `: ${o.note}` : ""}`;
}

/** Where Claude Code keeps the defaults /model and /effort save for new sessions, in its user settings. */
const DEFAULT_KEYS = ["model", "effortLevel", "modelSettings", "fastMode"] as const;

/**
 * Claude's user settings after `/model` and `/effort` (`after`), with the defaults they held before (`before`) put
 * back: those commands save their choice as the default for every new session, and a delegation means it for its one
 * agent. Only those keys go back; anything else changed meanwhile stays. null: nothing to put back, or a file that
 * isn't settings.
 */
export function restoreDefaults(before: string | null, after: string | null): string | null {
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
  for (const k of DEFAULT_KEYS) {
    if (JSON.stringify(now[k]) === JSON.stringify(was[k])) continue;
    changed = true;
    if (was[k] === undefined) delete out[k];
    else out[k] = was[k];
  }
  return changed ? `${JSON.stringify(out, null, 2)}\n` : null;
}
