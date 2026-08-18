import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * All admin-managed tmux sessions carry this prefix. We ONLY ever list, capture,
 * signal, or kill sessions that start with it — so the dashboard can never touch
 * unrelated tmux sessions (e.g. the `claude-*` ones) living on the host.
 */
const PREFIX = "admin-";

/** Where new sessions start. */
const DEFAULT_CWD = process.env.PROJECTS_ROOT
  ? process.env.PROJECTS_ROOT.replace(/\/projects\/?$/, "")
  : "/opt/project";

/**
 * Live status of a terminal:
 * - `idle`           — sitting at a shell prompt
 * - `busy`           — running some command (foreground process isn't a shell)
 * - `claude-working` — running the Claude CLI and mid-turn (thinking)
 * - `claude-waiting` — running the Claude CLI but waiting for your input
 */
export type TermStatus = "idle" | "busy" | "claude-working" | "claude-waiting";

export type Terminal = {
  name: string; // user-facing name (without the admin- prefix)
  target: string; // full tmux session name
  createdAt: number; // epoch ms
  attached: boolean;
  size: string; // e.g. "200x50"
  command: string; // foreground command in the pane
  busy: boolean; // a command is running (foreground != a shell)
  status: TermStatus;
  cwd: string; // pane current path
};

// Login/interactive shells that mean "sitting at a prompt" (idle). A pane whose
// foreground process is anything else is running a command (busy).
const SHELLS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "tcsh",
  "csh",
]);

function normalizeCmd(command: string): string {
  return command.replace(/^-/, "").trim(); // strip login-shell leading '-'
}

/** True when the pane's foreground command is a bare shell prompt (idle). */
export function isBusy(command: string): boolean {
  const cmd = normalizeCmd(command);
  if (!cmd) return false;
  return !SHELLS.has(cmd);
}

// The Claude CLI's foreground process is literally `claude`. While it is
// processing a turn it prints this interrupt hint; when it's done it shows the
// input prompt instead — so the hint is our "working vs waiting" signal.
const CLAUDE_WORKING_RE = /esc to interrupt/i;

/**
 * Classify a pane. `content` (a capture of the pane) is only needed to tell
 * whether a Claude session is actively working; without it a Claude pane is
 * reported as waiting.
 */
export function classify(command: string, content?: string): TermStatus {
  const cmd = normalizeCmd(command);
  if (cmd === "claude") {
    return content && CLAUDE_WORKING_RE.test(content)
      ? "claude-working"
      : "claude-waiting";
  }
  return isBusy(command) ? "busy" : "idle";
}

// A session name may be almost anything the user likes, EXCEPT characters that
// break tmux's `session:window.pane` target syntax (`.` and `:`) or its capture
// (control chars), plus leading/trailing whitespace. Everything else — spaces,
// uppercase, punctuation, unicode — is fair game, up to 64 chars.
const FORBIDDEN = /[.:\x00-\x1f\x7f]/;
const MAX_NAME = 64;

/** Validate a user-supplied session name and return the full tmux target. */
export function toTarget(name: string): string {
  if (
    !name ||
    name.length > MAX_NAME ||
    name !== name.trim() ||
    FORBIDDEN.test(name)
  ) {
    throw new Error(
      "invalid name (no dots, colons or control characters, no leading/trailing spaces; max 64 chars)",
    );
  }
  return PREFIX + name;
}

/**
 * A tmux session name may itself contain dashes, so strip only the leading
 * prefix once to recover the user-facing name.
 */
function stripPrefix(target: string): string {
  return target.startsWith(PREFIX) ? target.slice(PREFIX.length) : target;
}

/** tmux exits non-zero with "no server running" when nothing exists yet. */
function isNoServer(err: unknown): boolean {
  const msg = (err as { stderr?: string; message?: string }).stderr ?? "";
  return /no server running|no such file|error connecting/i.test(
    msg + ((err as Error).message ?? ""),
  );
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await exec("tmux", args, {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function listTerminals(): Promise<Terminal[]> {
  let out: string;
  try {
    out = await tmux([
      "list-sessions",
      "-F",
      [
        "#{session_name}",
        "#{session_created}",
        "#{session_attached}",
        "#{window_width}x#{window_height}",
        "#{pane_current_command}",
        "#{pane_current_path}",
      ].join("\t"),
    ]);
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
  const base = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((f) => f[0]?.startsWith(PREFIX))
    .map((f) => ({
      name: stripPrefix(f[0]),
      target: f[0],
      createdAt: (Number(f[1]) || 0) * 1000,
      attached: f[2] === "1",
      size: f[3] ?? "",
      command: f[4] ?? "",
      busy: isBusy(f[4] ?? ""),
      cwd: f[5] ?? "",
    }))
    .sort((a, b) => a.createdAt - b.createdAt);

  // A Claude pane's "working vs waiting" state only shows in its output, so
  // capture the visible pane for those (cheap: no scrollback/escapes) and
  // classify. Non-Claude panes are classified from the command alone.
  return Promise.all(
    base.map(async (t): Promise<Terminal> => {
      if (normalizeCmd(t.command) !== "claude") {
        return { ...t, status: classify(t.command) };
      }
      let content: string | undefined;
      try {
        content = await tmux(["capture-pane", "-p", "-t", t.target]);
      } catch {
        /* ignore */
      }
      return { ...t, status: classify(t.command, content) };
    }),
  );
}

async function sessionExists(target: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", target]);
    return true;
  } catch {
    return false;
  }
}

export async function createTerminal(
  name: string,
  opts: { cols?: number; rows?: number } = {},
): Promise<Terminal> {
  const target = toTarget(name);
  if (await sessionExists(target)) {
    throw new Error(`a terminal named "${name}" already exists`);
  }
  const cols = clamp(opts.cols ?? 200, 20, 500);
  const rows = clamp(opts.rows ?? 50, 5, 200);
  await tmux([
    "new-session",
    "-d",
    "-s",
    target,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-c",
    DEFAULT_CWD,
  ]);
  const list = await listTerminals();
  const created = list.find((t) => t.target === target);
  if (!created) throw new Error("session created but not found");
  return created;
}

export async function killTerminal(name: string): Promise<void> {
  const target = toTarget(name);
  await tmux(["kill-session", "-t", target]);
}

export async function renameTerminal(
  name: string,
  newName: string,
): Promise<Terminal> {
  const target = toTarget(name);
  const newTarget = toTarget(newName);
  if (newTarget === target) {
    const cur = (await listTerminals()).find((t) => t.target === target);
    if (!cur) throw new Error(`no terminal named "${name}"`);
    return cur;
  }
  if (await sessionExists(newTarget)) {
    throw new Error(`a terminal named "${newName}" already exists`);
  }
  await tmux(["rename-session", "-t", target, newTarget]);
  const renamed = (await listTerminals()).find((t) => t.target === newTarget);
  if (!renamed) throw new Error("renamed but not found");
  return renamed;
}

/** Lines of tmux scrollback to include above the visible pane, so the UI can
 *  scroll up to re-read old output. Bounds the payload polled once a second. */
const SCROLLBACK_LINES = 1000;

/**
 * Current pane contents plus up to `SCROLLBACK_LINES` of scrollback above it
 * (`-S -N`), so the UI can scroll up to retrieve old output. Captured without
 * `-J`, so each line is at most the pane width. `-e` keeps ANSI colour/attribute
 * escapes so the UI can render the terminal's real colours. When less history
 * exists, tmux simply starts at the oldest available line.
 */
export async function captureTerminal(name: string): Promise<{
  content: string;
  size: string;
  command: string;
  busy: boolean;
  status: TermStatus;
}> {
  const target = toTarget(name);
  const raw = await tmux([
    "capture-pane",
    "-p",
    "-e",
    "-S",
    `-${SCROLLBACK_LINES}`,
    "-t",
    target,
  ]);
  // tmux pads the capture with blank lines to the full pane height; drop the
  // trailing blanks so the prompt isn't pushed against a scroll region.
  const content = raw.replace(/\s+$/, "");
  let size = "";
  let command = "";
  let visible = "";
  try {
    const info = (
      await tmux([
        "display-message",
        "-p",
        "-t",
        target,
        "#{window_width}x#{window_height}\t#{pane_current_command}",
      ])
    ).trim();
    [size = "", command = ""] = info.split("\t");
  } catch {
    /* ignore */
  }
  // Classify from the VISIBLE pane only — never the scrollback above — so a
  // stale "esc to interrupt" scrolled off the top can't make an idle Claude
  // read as "working". This matches how listTerminals() classifies.
  try {
    visible = await tmux(["capture-pane", "-p", "-t", target]);
  } catch {
    /* ignore */
  }
  return {
    content,
    size,
    command,
    busy: isBusy(command),
    status: classify(command, visible),
  };
}

/** tmux key names we accept for non-literal input (avoids arg injection). */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "BTab",
  "Escape",
  "Space",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "C-c",
  "C-d",
  "C-z",
  "C-l",
  "C-a",
  "C-e",
  "C-u",
  "C-k",
  "C-r",
]);

export function isNamedKey(k: string): boolean {
  // The fixed set above, plus any Ctrl+letter (the mobile "Ctrl" modifier arms
  // an arbitrary C-<letter>). The strict pattern keeps it injection-safe.
  return NAMED_KEYS.has(k) || /^C-[a-z]$/.test(k);
}

/** Type literal text into the session (no trailing newline). */
export async function sendText(name: string, text: string): Promise<void> {
  const target = toTarget(name);
  // `-l` = literal, `--` stops option parsing so text starting with `-` is safe.
  await tmux(["send-keys", "-t", target, "-l", "--", text]);
}

/** Send a named key (Enter, C-c, arrows, …). */
export async function sendKey(name: string, key: string): Promise<void> {
  if (!isNamedKey(key)) throw new Error(`unsupported key: ${key}`);
  const target = toTarget(name);
  await tmux(["send-keys", "-t", target, key]);
}

/** Resize the (detached) window so capture width matches the viewport. */
export async function resizeTerminal(
  name: string,
  cols: number,
  rows: number,
): Promise<void> {
  const target = toTarget(name);
  await tmux([
    "resize-window",
    "-t",
    target,
    "-x",
    String(clamp(cols, 20, 500)),
    "-y",
    String(clamp(rows, 5, 200)),
  ]);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
