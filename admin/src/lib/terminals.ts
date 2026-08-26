import "server-only";

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * - `claude-working` — running the Claude CLI and mid-turn (active/thinking)
 * - `claude-idle`    — running the Claude CLI, sitting idle at its prompt
 * - `claude-input`   — the Claude CLI is blocked on a prompt asking for your input
 */
export type TermStatus =
  | "idle"
  | "busy"
  | "claude-working"
  | "claude-idle"
  | "claude-input";

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
  tokens: ClaudeTokens | null; // cumulative session tokens (Claude sessions only)
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
// input prompt instead — so the hint is our "active vs not" signal.
const CLAUDE_WORKING_RE = /esc to interrupt/i;

// When Claude is blocked asking you to choose (a permission / plan-approval /
// multiple-choice prompt) it draws a selection list — the `❯` arrow pointing at
// a numbered option, or an explicit "do you want to proceed" confirmation. That
// distinguishes "needs your input" from just idling at the ready prompt (whose
// `❯` is followed by the input cursor, not a numbered choice).
const CLAUDE_INPUT_RE =
  /❯\s+\d+\.\s|Do you want to proceed|Would you like to proceed/i;

/**
 * Classify a pane. `content` (a capture of the pane) is needed to tell a Claude
 * session's sub-state apart (active / awaiting input / idle); without it a
 * Claude pane is reported as idle.
 */
export function classify(command: string, content?: string): TermStatus {
  const cmd = normalizeCmd(command);
  if (cmd === "claude") {
    if (content && CLAUDE_WORKING_RE.test(content)) return "claude-working";
    if (content && CLAUDE_INPUT_RE.test(content)) return "claude-input";
    return "claude-idle";
  }
  return isBusy(command) ? "busy" : "idle";
}

export type ClaudeTokens = { input: number; output: number; total: number };

// The Claude CLI prints a live token meter on its status line, e.g.
//   ✻ Working… (5m 58s · ↑ 12.3k tokens · ↓ 24.3k tokens)
// `↑` is input (sent to the model), `↓` is output (generated). Either arrow may
// be absent. We surface the sum so a Claude terminal shows how much it has
// chewed through this turn.
const TOKEN_RE = /([↑↓])\s*([\d.]+)\s*([kKmM]?)\s*tokens/g;

// ANSI/VT escape sequences (colours, cursor moves) that tmux interleaves into a
// coloured capture — stripped before token parsing so escapes between the arrow
// and the number can't defeat the match.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function scaleTokens(num: string, suffix: string): number {
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return 0;
  const s = suffix.toLowerCase();
  const mult = s === "m" ? 1_000_000 : s === "k" ? 1_000 : 1;
  return Math.round(n * mult);
}

/**
 * Extract the input/output token counts the Claude CLI shows on its status
 * line. Takes the last occurrence of each arrow (the CLI redraws a single live
 * line, so the most recent is the current total). Returns null when no meter is
 * visible (e.g. an idle Claude waiting at its prompt).
 */
export function parseClaudeTokens(content?: string): ClaudeTokens | null {
  if (!content) return null;
  const clean = content.replace(ANSI_RE, "");
  let input: number | null = null;
  let output: number | null = null;
  for (const m of clean.matchAll(TOKEN_RE)) {
    const val = scaleTokens(m[2], m[3]);
    if (m[1] === "↑") input = val;
    else output = val;
  }
  if (input === null && output === null) return null;
  const i = input ?? 0;
  const o = output ?? 0;
  return { input: i, output: o, total: i + o };
}

// The CLI's status-line meter is PER TURN — it counts up while Claude works,
// then resets when the next turn starts and vanishes when it's idle. To show a
// running total for the whole session we accumulate those turns here, keyed by
// tmux target. `counted` is the monotonic cumulative we surface; `prev` is the
// last turn reading whose growth is already folded into `counted`.
type TokenAccum = { counted: ClaudeTokens; prev: ClaudeTokens };

// The running totals are mirrored to disk so they survive an admin-server
// restart — a `next dev` hot-reload (or a systemd restart) wipes module memory,
// but the tmux sessions outlive the server, so their cumulative token counts
// should too. Keyed by tmux target; loaded once at module init and rewritten
// whenever a tally changes. All writes are synchronous, preserving
// accumulateTokens()' no-await guarantee against double-counting.
const TOKENS_FILE = "/tmp/projects/terminal-tokens.json";

function loadTokens(): Map<string, TokenAccum> {
  try {
    const obj = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<
      string,
      TokenAccum
    >;
    return new Map(Object.entries(obj));
  } catch {
    return new Map(); // no file yet / malformed → start fresh
  }
}

function persistTokens(): void {
  try {
    mkdirSync(dirname(TOKENS_FILE), { recursive: true });
    writeFileSync(TOKENS_FILE, JSON.stringify(Object.fromEntries(sessionTokens)));
  } catch {
    /* best-effort: a lost tally just resets the count */
  }
}

const sessionTokens = loadTokens();
const ZERO: ClaudeTokens = { input: 0, output: 0, total: 0 };

/**
 * Fold a session's current per-turn meter reading into its cumulative total and
 * return the running total. Fully synchronous (no await), so overlapping pollers
 * can't double-count: whoever runs first advances `prev`, leaving a zero delta
 * for the next. Returns null for a session that has never shown a meter.
 *
 * `active` is whether the pane is mid-turn (status `claude-working`). It's the
 * reliable turn boundary: when the pane isn't working we close the turn out so
 * the next one counts from zero — and, crucially, we do NOT do that merely
 * because `turn` is null, since a single capture can miss the meter line while
 * Claude is still working (that would otherwise re-count the whole turn). A
 * meter reading that shrank is a secondary new-turn signal, covering the case
 * where two turns run back-to-back and the idle frame between them is polled
 * over.
 */
export function accumulateTokens(
  target: string,
  turn: ClaudeTokens | null,
  active: boolean,
): ClaudeTokens | null {
  const acc = sessionTokens.get(target);
  if (!acc) {
    if (!turn) return null;
    // First reading. If it's not from an active turn, the turn is already done,
    // so leave `prev` empty and let the next turn count from scratch.
    const fresh: TokenAccum = { counted: turn, prev: active ? turn : ZERO };
    sessionTokens.set(target, fresh);
    persistTokens();
    return fresh.counted;
  }
  if (!active) {
    // Turn finished — next turn starts fresh. Only rewrite the file when `prev`
    // actually changes, so an idle Claude polled every second doesn't churn it.
    if (acc.prev.total !== 0) {
      acc.prev = ZERO;
      persistTokens();
    }
    return acc.counted;
  }
  if (!turn) return acc.counted; // mid-turn capture missed the meter; keep prev
  // Same turn still growing → add the delta; a smaller reading means a new turn
  // reset the meter, so the prior turn is already fully counted and this turn's
  // whole value is new.
  const grew = turn.total >= acc.prev.total;
  const add = (cur: number, was: number) => Math.max(0, grew ? cur - was : cur);
  acc.counted = {
    input: acc.counted.input + add(turn.input, acc.prev.input),
    output: acc.counted.output + add(turn.output, acc.prev.output),
    total: acc.counted.total + add(turn.total, acc.prev.total),
  };
  acc.prev = turn;
  persistTokens();
  return acc.counted;
}

/** Forget a session's token tally (called when its tmux session disappears). */
function pruneTokens(liveTargets: Set<string>) {
  let changed = false;
  for (const target of sessionTokens.keys()) {
    if (!liveTargets.has(target)) {
      sessionTokens.delete(target);
      changed = true;
    }
  }
  if (changed) persistTokens();
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
  // classify. That same capture carries the token meter, so we fold it into the
  // session's running total here — this poll runs even when no window is open,
  // so the sidebar's cumulative count stays live. Non-Claude panes are
  // classified from the command alone and carry no token tally.
  const terminals = await Promise.all(
    base.map(async (t): Promise<Terminal> => {
      if (normalizeCmd(t.command) !== "claude") {
        return { ...t, status: classify(t.command), tokens: null };
      }
      let content: string | undefined;
      try {
        content = await tmux(["capture-pane", "-p", "-t", t.target]);
      } catch {
        /* ignore */
      }
      const status = classify(t.command, content);
      const tokens = accumulateTokens(
        t.target,
        parseClaudeTokens(content),
        status === "claude-working",
      );
      return { ...t, status, tokens };
    }),
  );
  // Drop tallies for sessions that no longer exist so the map can't grow without
  // bound (killed sessions, renames handled separately).
  pruneTokens(new Set(base.map((t) => t.target)));
  return terminals;
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
  // Carry the token tally over to the new target so a rename doesn't zero it
  // (and so prune doesn't drop it for the vanished old name).
  const acc = sessionTokens.get(target);
  if (acc) {
    sessionTokens.set(newTarget, acc);
    sessionTokens.delete(target);
    persistTokens();
  }
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
  tokens: ClaudeTokens | null;
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
  const status = classify(command, visible);
  return {
    content,
    size,
    command,
    busy: isBusy(command),
    status,
    // Parse from the visible pane only (a meter scrolled off the top can't
    // linger), then fold it into the session's running total so the window
    // footer shows the same cumulative figure as the sidebar.
    tokens: accumulateTokens(
      target,
      parseClaudeTokens(visible),
      status === "claude-working",
    ),
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
