import { redactTerminal } from "@/lib/claude-comms-parse";
import { SECRET_PATTERNS } from "@/lib/repo-file-guard";

/**
 * An agent's thinking for Agents City's bubbles (T205; T205b: thinking only, the user's choice): the first line of
 * each thinking block its transcript holds. Every line goes through the panes' redaction and the team secrets hook's
 * patterns, and is at most STEP_MAX characters (the bubble wraps it on two lines, T205d): never more than a line,
 * never a secret.
 */

export type StepKind = "tool" | "say" | "think";
export type AgentStep = { t: string; kind: StepKind; text: string };

export const STEP_MAX = 140;


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

/** a tool call as Agents City's monitors draw it (T205c): its kind and a size, never its text */
export type AgentAct = { kind: "edit" | "read" | "bash" | "other"; at: string; len: number };
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]), READS = new Set(["Read", "Grep", "Glob", "LS"]);
/** the size counted: what it writes (an edit's new text, a file written), a command's length; 0 for the rest */
export function actOf(tool: string, input: Record<string, unknown>, at: string): AgentAct {
  const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
  const kind = EDITS.has(tool) ? "edit" : READS.has(tool) ? "read" : tool === "Bash" ? "bash" : "other";
  const n =
    tool === "MultiEdit" && Array.isArray(input.edits) ? input.edits.reduce((a: number, e) => a + (e && typeof e === "object" && "new_string" in e ? len(e.new_string) : 0), 0)
    : tool === "Edit" ? len(input.new_string)
    : tool === "Write" ? len(input.content)
    : tool === "NotebookEdit" ? len(input.new_source)
    : tool === "Bash" ? len(input.command)
    : 0;
  return { kind, at, len: Math.min(9999, n) };
}
