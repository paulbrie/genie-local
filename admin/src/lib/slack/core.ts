/**
 * The Slack bot's pure half: what a message asks for, which terminal changes are
 * worth an alert, and what gets posted back. No I/O here, so it is tested on its
 * own (core.test.ts); bot.ts wires it to tmux, the database and Slack.
 */
import type { TermStatus } from "@/lib/terminals";

// ── Who may use it ───────────────────────────────────────────────────────────

/** Slack user ids from SLACK_ALLOWED_USERS ("U012AB3CD, U045EF6GH"). */
export function parseAllowed(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^[UW][A-Z0-9]{2,}$/.test(s)),
  );
}

// ── Slack text ───────────────────────────────────────────────────────────────

/**
 * What someone typed, from Slack's encoding of it: <https://x|label> and <mailto:…>
 * back to the address, <@U…> mentions and <#C…|name> channels to their labels,
 * and &amp; &lt; &gt; unescaped. Mentions of the bot itself are dropped.
 */
export function slackToPlain(text: string, botUserId?: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => (id === botUserId ? "" : `@${id}`))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(?:mailto:)?([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Escapes what Slack would read as markup, for text we post (pane output included). */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One line to type into a terminal: tmux send-keys submits at every newline, so a
 * multi-line message would arrive in pieces (see delegateBrief).
 */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// ── Commands ─────────────────────────────────────────────────────────────────

export type Command =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "show"; terminal: string; lines: number }
  | { kind: "send"; terminal: string; text: string }
  | { kind: "key"; terminal: string; key: string }
  | { kind: "ask"; question: string }
  | { kind: "projects" }
  | { kind: "tasks"; project: string; all: boolean }
  | { kind: "task-add"; project: string; title: string }
  | { kind: "task-status"; project: string; id: number; status: "open" | "in_progress" | "done" }
  | { kind: "mute"; terminal: string | null }
  | { kind: "unmute"; terminal: string }
  | { kind: "error"; message: string };

export const HELP = [
  "*Terminals*",
  "• `status` — every terminal and what it's doing",
  "• `show <terminal> [lines]` — the end of its screen",
  "• `send <terminal> <text>` — type a line into it (Enter included)",
  "• `key <terminal> <key>` — press a key: `1`…`9`, `esc`, `enter`, `tab`, `up`, `down`, `ctrl-c`",
  "• `ask <question>` — ask about what the terminals are doing",
  "• `mute [terminal]` / `unmute <terminal>` — stop or resume its alerts (no name lists the muted ones)",
  "*Tasks*",
  "• `projects` — the projects",
  "• `tasks <project> [all]` — its open and in-progress tasks (`all` adds the done ones)",
  "• `task add <project> <title>`",
  "• `task start|done|reopen <project> <id>`",
  "*Replies*",
  "Reply in an alert's thread to type into that terminal. When it's waiting on a choice, reply with the option's number, or `!esc` to dismiss it; `!enter`, `!ctrl-c`, `!up`, `!down`, `!tab` press those keys.",
].join("\n");

/** Splits off the first word, or a "quoted name" (terminal names may hold spaces). */
function firstArg(s: string): [string, string] {
  const t = s.trimStart();
  const q = /^["“]([^"”]+)["”]\s*/.exec(t);
  if (q) return [q[1], t.slice(q[0].length)];
  const m = /^(\S+)\s*/.exec(t);
  return m ? [m[1], t.slice(m[0].length)] : ["", ""];
}

/** The keys a reply or `key` may press, by the words people type for them. */
const KEY_WORDS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  "shift-tab": "BTab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  space: "Space",
  backspace: "BSpace",
  "ctrl-c": "C-c",
  "c-c": "C-c",
  "^c": "C-c",
  "ctrl-d": "C-d",
  "c-d": "C-d",
};

/** A key word to what terminals.sendKey / sendText takes; a digit is typed as itself. */
export function keyFor(word: string): { named: string } | { text: string } | null {
  const w = word.trim().toLowerCase();
  if (/^[0-9]$/.test(w)) return { text: w };
  const named = KEY_WORDS[w];
  return named ? { named } : null;
}

export function parseCommand(input: string): Command {
  const text = input.trim();
  const [word, rest] = firstArg(text);
  const verb = word.toLowerCase();
  switch (verb) {
    case "":
    case "status":
    case "ls":
    case "list":
      return { kind: "status" };
    case "help":
    case "?":
      return { kind: "help" };
    case "show":
    case "screen": {
      const [terminal, more] = firstArg(rest);
      if (!terminal) return { kind: "error", message: "Which terminal? `show <terminal>`" };
      const n = Number(more.trim());
      return { kind: "show", terminal, lines: Number.isInteger(n) && n > 0 ? Math.min(n, 120) : 30 };
    }
    case "send":
    case "type": {
      const [terminal, body] = firstArg(rest);
      const line = oneLine(body);
      if (!terminal || !line) return { kind: "error", message: "`send <terminal> <text>`" };
      return { kind: "send", terminal, text: line };
    }
    case "key":
    case "press": {
      const [terminal, k] = firstArg(rest);
      if (!terminal || !k.trim()) return { kind: "error", message: "`key <terminal> <key>`" };
      if (!keyFor(k)) return { kind: "error", message: `I don't know the key \`${k.trim()}\`. ${KEY_LIST}` };
      return { kind: "key", terminal, key: k.trim().toLowerCase() };
    }
    case "ask": {
      const question = oneLine(rest);
      if (!question) return { kind: "error", message: "`ask <question>`" };
      return { kind: "ask", question: question.slice(0, 500) };
    }
    case "projects":
      return { kind: "projects" };
    case "tasks": {
      const [project, more] = firstArg(rest);
      if (!project) return { kind: "error", message: "Which project? `tasks <project>`" };
      return { kind: "tasks", project, all: /^all$/i.test(more.trim()) };
    }
    case "task": {
      const [sub, after] = firstArg(rest);
      const [project, tail] = firstArg(after);
      const s = sub.toLowerCase();
      if (s === "add" || s === "new") {
        const title = oneLine(tail);
        if (!project || !title) return { kind: "error", message: "`task add <project> <title>`" };
        return { kind: "task-add", project, title: title.slice(0, 500) };
      }
      const status = s === "done" ? "done" : s === "start" ? "in_progress" : s === "reopen" || s === "open" ? "open" : null;
      if (!status) return { kind: "error", message: "`task add|start|done|reopen …`" };
      const id = Number(tail.trim().replace(/^#/, ""));
      if (!project || !Number.isInteger(id) || id <= 0) {
        return { kind: "error", message: `\`task ${s} <project> <id>\`` };
      }
      return { kind: "task-status", project, id, status };
    }
    case "mute": {
      const [terminal] = firstArg(rest);
      return { kind: "mute", terminal: terminal || null };
    }
    case "unmute": {
      const [terminal] = firstArg(rest);
      if (!terminal) return { kind: "error", message: "`unmute <terminal>`" };
      return { kind: "unmute", terminal };
    }
    default:
      return { kind: "error", message: `I don't know \`${escapeSlack(word)}\`. Try \`help\`.` };
  }
}

const KEY_LIST = "Keys: `1`…`9`, `esc`, `enter`, `tab`, `up`, `down`, `ctrl-c`.";

/**
 * A reply in a terminal's thread: a key ("!esc", or a bare digit while it's waiting
 * on a choice) or a line to type. A line can't answer a choice (it would land in
 * the menu as keystrokes), so that is refused with the way to do it.
 */
export type Reply = { kind: "key"; key: { named: string } | { text: string } } | { kind: "line"; text: string } | { kind: "error"; message: string };

export function parseReply(input: string, status: TermStatus | null): Reply {
  const text = oneLine(input);
  if (!text) return { kind: "error", message: "That reply was empty." };
  if (text.startsWith("!")) {
    const key = keyFor(text.slice(1));
    return key ? { kind: "key", key } : { kind: "error", message: `I don't know the key \`${escapeSlack(text)}\`. ${KEY_LIST}` };
  }
  if (status === "claude-input") {
    if (/^[0-9]$/.test(text)) return { kind: "key", key: { text } };
    return {
      kind: "error",
      message: "It's waiting on a choice: reply with the option's number, or `!esc` to dismiss it and then send your text.",
    };
  }
  return { kind: "line", text };
}

// ── Pane output ──────────────────────────────────────────────────────────────

// CSI (colours, cursor moves), OSC (titles, links; BEL- or ST-terminated) and lone ESC sequences.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

const RULE_RE = /^\s*[─━═]{8,}/;

/**
 * The part of a pane worth reading in Slack: ANSI and trailing blanks dropped, and
 * for a Claude session at rest its input box and footer cut off (from the box's
 * top rule down), so what's left ends with its last message. A choice it is
 * waiting on is kept whole: that is the point of the alert.
 */
export function paneExcerpt(content: string, status: TermStatus | null, maxLines = 30, maxChars = 2800): string {
  let lines = stripAnsi(content)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  if (status && status.startsWith("claude-") && status !== "claude-input") {
    const prompt = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
    if (prompt > 0) {
      const top = lines.slice(0, prompt).findLastIndex((l) => RULE_RE.test(l));
      if (top > 0) lines = lines.slice(0, top);
    }
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  lines = lines.slice(-maxLines);
  while (lines.length && !lines[0]) lines.shift();
  let out = lines.join("\n");
  if (out.length > maxChars) out = "…" + out.slice(out.length - maxChars + 1);
  return out;
}

export type Choice = { n: number; label: string };

const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;

/**
 * The options of the choice a Claude pane is waiting on ("❯ 1. Yes", "  2. No"):
 * the numbered lines around the one the ❯ points at, numbered 1, 2, 3… with no
 * gaps. Numbered lines further up (a list in Claude's own message) aren't
 * options; neither is anything when no ❯ points at a number.
 */
export function parseChoices(content: string): Choice[] {
  const lines = stripAnsi(content).split("\n");
  const at = lines.findLastIndex((l) => /^\s*❯\s*\d{1,2}\.\s/.test(l));
  if (at < 0) return [];
  const near = new Map<number, string>();
  const scan = (from: number, step: number) => {
    let gap = 0;
    for (let i = from; i >= 0 && i < lines.length && gap <= 3; i += step) {
      const m = OPTION_RE.exec(lines[i]);
      if (!m) {
        gap += 1;
        continue;
      }
      gap = 0;
      const n = Number(m[1]);
      if (!near.has(n)) near.set(n, m[2].replace(/\s{2,}.*$/, ""));
    }
  };
  scan(at, -1);
  scan(at + 1, 1);
  const out: Choice[] = [];
  for (let n = 1; near.has(n) && n <= 9; n++) out.push({ n, label: near.get(n)! });
  return out;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export type AlertEvent = "needs-input" | "finished";

export type WatchMem = {
  status: TermStatus;
  /** Has worked since the last alert (a rest after this is a turn that finished). */
  latch: boolean;
  /** A new status, and how many polls in a row it has been seen: one poll can be a flicker. */
  pending: { status: TermStatus; seen: number } | null;
  lastAlert: { event: AlertEvent; at: number } | null;
};

const isRest = (s: TermStatus) => s === "claude-idle" || s === "claude-background";
/** Idle and idle-with-background-work are one rest: moving between them is no change. */
const same = (a: TermStatus, b: TermStatus) => a === b || (isRest(a) && isRest(b));

/** Polls a new status must hold for before it counts ("esc to interrupt" blinks out between steps). */
export const STEADY_POLLS = 2;
/**
 * A prompt alert for the same terminal at most this often (a prompt that flaps).
 * A finished turn needs work in between, so a quick answer to a reply still gets one.
 */
export const ALERT_COOLDOWN_MS = 20_000;

/**
 * One poll of the terminals against what was seen before: the alerts to post, and
 * the memory for the next poll. A Claude session that finished a turn, or is now
 * waiting on a choice, gets one; the first sighting of a terminal (the server just
 * started) only records it, and terminals that are gone are forgotten.
 */
export function detectAlerts(
  mem: Map<string, WatchMem>,
  list: { name: string; status: TermStatus }[],
  now: number,
): { mem: Map<string, WatchMem>; alerts: { name: string; event: AlertEvent }[] } {
  const next = new Map<string, WatchMem>();
  const alerts: { name: string; event: AlertEvent }[] = [];
  for (const t of list) {
    const prev = mem.get(t.name);
    if (!prev) {
      next.set(t.name, { status: t.status, latch: t.status === "claude-working", pending: null, lastAlert: null });
      continue;
    }
    if (same(t.status, prev.status)) {
      next.set(t.name, { ...prev, status: t.status, pending: null, latch: prev.latch || t.status === "claude-working" });
      continue;
    }
    const seen = prev.pending && same(prev.pending.status, t.status) ? prev.pending.seen + 1 : 1;
    // Working starts at once (it only arms the latch); a rest or a prompt has to hold.
    if (t.status !== "claude-working" && seen < STEADY_POLLS) {
      next.set(t.name, { ...prev, pending: { status: t.status, seen } });
      continue;
    }
    let event: AlertEvent | null = null;
    if (t.status === "claude-input") event = "needs-input";
    else if (isRest(t.status) && prev.latch) event = "finished";
    let lastAlert = prev.lastAlert;
    const tooSoon = event === "needs-input" && lastAlert?.event === event && now - lastAlert.at < ALERT_COOLDOWN_MS;
    if (event && !tooSoon) {
      alerts.push({ name: t.name, event });
      lastAlert = { event, at: now };
    }
    next.set(t.name, {
      status: t.status,
      latch: t.status === "claude-working" ? true : event || isRest(t.status) || t.status === "claude-input" ? false : prev.latch,
      pending: null,
      lastAlert,
    });
  }
  return { mem: next, alerts };
}

// ── Messages ─────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<TermStatus, string> = {
  idle: ":white_circle: idle",
  busy: ":large_blue_circle: running a command",
  "claude-working": ":hourglass_flowing_sand: Claude working",
  "claude-idle": ":white_check_mark: Claude idle",
  "claude-background": ":gear: Claude idle, work in the background",
  "claude-input": ":raised_hand: Claude waiting on you",
};

export type Block = Record<string, unknown>;

const codeBlock = (s: string) => "```\n" + escapeSlack(s || "(nothing on screen)") + "\n```";

/** Button values carry the terminal and the key: `{"t":"…","k":"1"}`. */
export type ButtonValue = { t: string; k: string };

export const ACTION_KEY = "genie_key";
export const ACTION_SHOW = "genie_show";

function button(text: string, action: string, value: ButtonValue, style?: "primary" | "danger"): Block {
  return {
    type: "button",
    text: { type: "plain_text", text: text.slice(0, 75), emoji: true },
    action_id: `${action}:${value.k}`,
    value: JSON.stringify(value),
    ...(style ? { style } : {}),
  };
}

/** The alert for a terminal that finished a turn or waits on a choice, with its screen and buttons to answer. */
export function alertMessage(
  name: string,
  event: AlertEvent,
  excerpt: string,
  choices: Choice[],
  link?: string,
): { text: string; blocks: Block[] } {
  const who = link ? `<${link}|${escapeSlack(name)}>` : `*${escapeSlack(name)}*`;
  const head =
    event === "needs-input" ? `:raised_hand: ${who} is waiting on you` : `:white_check_mark: ${who} finished`;
  const text = event === "needs-input" ? `${name} is waiting on you` : `${name} finished`;
  const actions: Block[] = [
    ...choices.map((c) => button(`${c.n}. ${c.label}`, ACTION_KEY, { t: name, k: String(c.n) }, c.n === 1 ? "primary" : undefined)),
    ...(event === "needs-input" ? [button("Esc", ACTION_KEY, { t: name, k: "esc" })] : []),
    button("Show screen", ACTION_SHOW, { t: name, k: "show" }),
  ];
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: head } },
      { type: "section", text: { type: "mrkdwn", text: codeBlock(excerpt) } },
      { type: "actions", elements: actions.slice(0, 25) },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Reply in this thread to type into the terminal." }],
      },
    ],
  };
}

/** `show`: a terminal's screen, as a message whose thread is that terminal's. */
export function screenMessage(name: string, status: TermStatus | null, excerpt: string): { text: string; blocks: Block[] } {
  const label = status ? STATUS_LABEL[status] : "";
  return {
    text: `${name}: ${label}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(name)}* · ${label}` } },
      { type: "section", text: { type: "mrkdwn", text: codeBlock(excerpt) } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Reply in this thread to type into the terminal." }] },
    ],
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** `status`: one line per terminal. */
export function statusText(
  terminals: { name: string; status: TermStatus; dead: boolean; tokens: { total: number } | null; cwd: string }[],
  muted: Set<string>,
): string {
  if (!terminals.length) return "No terminals are open.";
  return terminals
    .map((t) => {
      const state = t.dead ? ":black_circle: exited" : STATUS_LABEL[t.status];
      const extra = [
        t.tokens ? `${formatTokens(t.tokens.total)} tokens` : "",
        muted.has(t.name) ? ":no_bell: muted" : "",
      ].filter(Boolean);
      return `*${escapeSlack(t.name)}* · ${state}${extra.length ? " · " + extra.join(" · ") : ""} · \`${escapeSlack(t.cwd)}\``;
    })
    .join("\n");
}

const TASK_MARK: Record<string, string> = { open: ":white_square:", in_progress: ":arrow_forward:", done: ":white_check_mark:" };

/** `tasks`: one line per task, open and in-progress ones first as on the board. */
export function tasksText(
  project: string,
  tasks: { id: number; title: string; status: string; assignee: string | null }[],
  all: boolean,
): string {
  const order: Record<string, number> = { in_progress: 0, open: 1, done: 2 };
  const shown = tasks
    .filter((t) => all || t.status !== "done")
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  if (!shown.length) return all ? `*${escapeSlack(project)}* has no tasks.` : `*${escapeSlack(project)}* has no open tasks.`;
  const lines = shown.slice(0, 40).map(
    (t) =>
      `${TASK_MARK[t.status] ?? "•"} #${t.id} ${escapeSlack(oneLine(t.title)).slice(0, 200)}${t.assignee ? ` · _${escapeSlack(t.assignee)}_` : ""}`,
  );
  if (shown.length > 40) lines.push(`…and ${shown.length - 40} more`);
  return `*${escapeSlack(project)}*\n${lines.join("\n")}`;
}
