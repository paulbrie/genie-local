import { redactTerminal } from "@/lib/claude-comms-parse";
import { SECRET_PATTERNS } from "@/lib/repo-file-guard";

/**
 * An agent's thinking for Agents City's bubbles (T205; T205b: thinking only, the user's choice): the first line of
 * each thinking block its transcript holds. Every line goes through the panes' redaction and the team secrets hook's
 * patterns, and is at most STEP_MAX characters: never more than a line, never a secret.
 */

export type StepKind = "tool" | "say" | "think";
export type AgentStep = { t: string; kind: StepKind; text: string };

export const STEP_MAX = 60;


/** a line made safe to show: redacted, one line, at most STEP_MAX characters */
export function cleanLine(text: string): string {
  let out = redactTerminal(text.replace(/\s+/g, " ").trim());
  for (const [rx] of SECRET_PATTERNS) out = out.replace(new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g"), "***");
  return out.length > STEP_MAX ? `${out.slice(0, STEP_MAX - 1)}…` : out;
}

/** the first non-empty line of a text (markdown markers off), made safe; null if none */
export function firstLine(text: string): string | null {
  // (markdown's marks off: a bullet or heading lead-in, bold, code ticks)
  const line = text.split("\n").map((l) => l.replace(/^[\s>#*\-•`]+/, "").replace(/\*\*|__|`/g, "").trim()).find((l) => l.length > 0);
  return line ? cleanLine(line) : null;
}
