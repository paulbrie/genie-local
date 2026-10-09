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
  CLAIM: "#e2e8f0",
  RELEASE: "#94a3b8",
  COMMIT: "#a855f7",
  PUSHED: "#06b6d4",
};

/** Colour for an untagged message. */
export const NOTE_COLOR = "#cbd5e1";
