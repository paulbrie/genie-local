import { redactTerminal } from "@/lib/claude-comms-parse";
import { SECRET_PATTERNS } from "@/lib/repo-file-guard";

/**
 * An agent's thinking steps for Agents City's bubbles (T205): each tool call in plain words ("reading
 * lane-sketch-sim.ts", "running npm test", "messaging Alice"), the first line of what it last wrote, the first line
 * of its last thinking (when the transcript holds it). Every line goes through the panes' redaction and the team
 * secrets hook's patterns, and is at most STEP_MAX characters: never a message body, never a secret.
 */

export type StepKind = "tool" | "say" | "think";
export type AgentStep = { t: string; kind: StepKind; text: string };

export const STEP_MAX = 60;

const base = (p: unknown) => (typeof p === "string" && p ? p.split("/").filter(Boolean).pop() ?? p : null);
const s = (v: unknown) => (typeof v === "string" ? v : null);

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

/** a peer's address as a name: "Alice", or "a peer" for a socket */
const who = (to: string | null) => (!to ? "someone" : to.includes(":") || to.startsWith("/") ? "a peer" : to);

/** a tool call in plain words */
export function toolStep(tool: string, input: Record<string, unknown>): string {
  const file = base(input.file_path) ?? base(input.notebook_path);
  switch (tool) {
    case "Read":
      return cleanLine(`reading ${file ?? "a file"}`);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return cleanLine(`editing ${file ?? "a file"}`);
    case "Write":
      return cleanLine(`writing ${file ?? "a file"}`);
    case "Bash": {
      // (its own description when it gave one, else the command's first words)
      const d = s(input.description), c = s(input.command);
      if (d) return cleanLine(`running: ${d.charAt(0).toLowerCase()}${d.slice(1)}`);
      return cleanLine(`running ${c ? c.split("\n")[0].split(/\s*(?:&&|\|\||;|\|)\s*/)[0].split(/\s+/).slice(0, 3).join(" ") : "a command"}`);
    }
    case "Grep":
      return cleanLine(`searching for ${s(input.pattern) ?? "text"}`);
    case "Glob":
      return cleanLine(`looking for ${s(input.pattern) ?? "files"}`);
    case "SendMessage":
      return cleanLine(`messaging ${who(s(input.to) ?? s(input.recipient))}`);
    case "WebSearch":
      return cleanLine(`searching the web: ${s(input.query) ?? ""}`);
    case "WebFetch": {
      const u = s(input.url);
      let host = "a page";
      try {
        if (u) host = new URL(u).host;
      } catch {
        /* not a URL */
      }
      return cleanLine(`fetching ${host}`);
    }
    case "Agent":
    case "Task":
      return cleanLine(`starting a helper${s(input.description) ? `: ${s(input.description)}` : ""}`);
    case "TodoWrite":
      return "updating its to-do list";
    case "Skill":
      return cleanLine(`using the ${s(input.skill) ?? "a"} skill`);
    default:
      return cleanLine(`using ${tool}`);
  }
}
