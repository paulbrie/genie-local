import type { TagName } from "@/lib/claude-comms-parse";

/**
 * One colour per message tag, shared by the Comms page badges and the 3D
 * views (pulses, arcs): dispatch blue, progress amber, blocked red, done
 * green, file claims neutral, commits violet, pushes cyan.
 */
export const TAG_COLORS: Record<TagName, string> = {
  TASK: "#3b82f6",
  ACK: "#f59e0b",
  STATUS: "#f59e0b",
  BLOCKED: "#ef4444",
  DONE: "#22c55e",
  CANCELLED: "#6b7280",
  CLAIM: "#e2e8f0",
  RELEASE: "#94a3b8",
  COMMIT: "#a855f7",
  PUSHED: "#06b6d4",
};

/** Colour for an untagged message. */
export const NOTE_COLOR = "#cbd5e1";

/**
 * Fixed colours for named agents, by current session name (case-insensitive),
 * shared by Comms, Agents City and the Desk mode: a rename to one of these
 * names takes its colour.
 */
export const NAMED_AGENT_COLORS: Record<string, string> = {
  alice: "#4ade80", // green
  bob: "#a855f7", // violet
  alex: "#ef4444", // red
  tatiana: "#14b8a6", // teal
  ramona: "#f59e0b", // amber
  tom: "#3b82f6", // blue
};

/** For every other session: hues clear of the named ones. */
export const OTHER_AGENT_PALETTE = ["#06b6d4", "#ec4899", "#84cc16", "#f97316", "#e879f9", "#facc15", "#94a3b8", "#fb7185"];

/** Colour per node key: named agents fixed, the rest from the palette in key order (stable under filters). */
export function agentColorMap(nodes: { key: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const n of [...nodes].sort((a, b) => a.key.localeCompare(b.key))) {
    const named = NAMED_AGENT_COLORS[n.name.trim().toLowerCase()];
    out.set(n.key, named ?? OTHER_AGENT_PALETTE[i++ % OTHER_AGENT_PALETTE.length]);
  }
  return out;
}
