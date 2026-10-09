import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { readRegistry } from "@/lib/claude-comms";
import { redact } from "@/lib/claude-comms-parse";

/**
 * Live text of each Claude Code session's tmux pane, for the Agents City
 * cards. Read-only (`tmux capture-pane`, never send-keys), redacted before it
 * leaves the server, captured only for the sessions a client asks about, and
 * cached for a moment so several viewers share one capture.
 */

const execFileAsync = promisify(execFile);
const CACHE_MS = 1000;
const MAX_LINES = 60;

export type PaneCapture = {
  pane: string | null;
  /** Redacted text (last lines), or null when the session has no pane. */
  text: string | null;
  /** Hash of the text, so clients can skip unchanged panes. */
  hash: string | null;
  at: string;
};

// ── Terminal-specific redaction (on top of the Comms redactor) ──────────────

const TERMINAL_REDACTIONS: [RegExp, string][] = [
  // Authorization / cookie / API-key headers, as in curl -v or HTTP dumps.
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)(\s*[:=]\s*)\S.*$/gim, "$1$2***"],
  // env dumps: KEY=value where the key looks sensitive (wider than the Comms rule).
  [/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|DSN|URL)[A-Z0-9_]*\s*=\s*).+$/gm, "$1***"],
  // Long opaque tokens: base64-ish runs mixing cases and digits, or very long hex.
  [/\b(?=[A-Za-z0-9+/_-]{40,}={0,2})(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted token]"],
  [/\b[0-9a-f]{48,}\b/gi, "[redacted hex]"],
];

export function redactTerminal(text: string): string {
  let out = redact(text);
  for (const [re, rep] of TERMINAL_REDACTIONS) out = out.replace(re, rep);
  return out;
}

// ── Session → pane ──────────────────────────────────────────────────────────

const PANE_RE = /^%\d+$/;

/** TMUX_PANE from a process's environment; nothing else from it is kept. */
async function paneFromEnviron(pid: number): Promise<string | null> {
  try {
    const env = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    const m = env.split("\0").find((kv) => kv.startsWith("TMUX_PANE="));
    const pane = m?.slice("TMUX_PANE=".length) ?? null;
    return pane && PANE_RE.test(pane) ? pane : null;
  } catch {
    return null;
  }
}

async function ppid(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // pid (comm) state ppid …; comm may contain spaces, so split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const p = Number(rest[1]);
    return p > 1 ? p : null;
  } catch {
    return null;
  }
}

/** pane_pid → pane_id for every tmux pane. */
async function listPanes(): Promise<Map<number, string>> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]);
    const out = new Map<number, string>();
    for (const line of stdout.split("\n")) {
      const [id, pid] = line.trim().split(" ");
      if (id && PANE_RE.test(id) && Number(pid)) out.set(Number(pid), id);
    }
    return out;
  } catch {
    return new Map();
  }
}

async function paneFor(entry: { pid: number; tmux: string | null }, panes: Map<number, string>): Promise<string | null> {
  const fromRegistry = entry.tmux?.match(/(%\d+)$/)?.[1];
  if (fromRegistry) return fromRegistry;
  const fromEnv = await paneFromEnviron(entry.pid);
  if (fromEnv) return fromEnv;
  // Walk up the process tree to a pane's shell.
  let p: number | null = entry.pid;
  for (let i = 0; p && i < 12; i++) {
    const hit = panes.get(p);
    if (hit) return hit;
    p = await ppid(p);
  }
  return null;
}

// ── Capture ─────────────────────────────────────────────────────────────────

const cache = new Map<string, PaneCapture & { t: number }>();

async function capture(pane: string, lines: number): Promise<PaneCapture> {
  const key = `${pane}:${lines}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit;
  let text: string | null = null;
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-t", pane, "-S", `-${lines}`], {
      maxBuffer: 2 * 1024 * 1024,
    });
    // Drop trailing blank lines (an idle pane's unused rows), keep the last `lines`.
    const all = stdout.replace(/\s+$/, "").split("\n");
    text = redactTerminal(all.slice(-lines).join("\n"));
  } catch {
    text = null;
  }
  const entry = {
    pane,
    text,
    hash: text == null ? null : createHash("sha1").update(text).digest("hex").slice(0, 12),
    at: new Date().toISOString(),
    t: Date.now(),
  };
  cache.set(key, entry);
  return entry;
}

/** Captures for the given session ids (node keys `s:<sessionId>`). */
export async function capturePanes(nodeKeys: string[], lines = 40): Promise<Record<string, PaneCapture>> {
  const n = Math.min(Math.max(1, Math.round(lines)), MAX_LINES);
  const { entries } = await readRegistry();
  const bySession = new Map(entries.map((e) => [e.sessionId, e]));
  const panes = await listPanes();
  const out: Record<string, PaneCapture> = {};
  await Promise.all(
    nodeKeys.slice(0, 24).map(async (key) => {
      const entry = key.startsWith("s:") ? bySession.get(key.slice(2)) : undefined;
      const pane = entry ? await paneFor(entry, panes) : null;
      out[key] = pane ? await capture(pane, n) : { pane: null, text: null, hash: null, at: new Date().toISOString() };
    }),
  );
  return out;
}
