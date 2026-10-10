/**
 * Pure (IO-free) half of the session-comms view: types shared with the client,
 * redaction, the message tag protocol, the keyword fallbacks for untagged
 * messages, and the derivation of tasks / file claims / commit mentions from a
 * list of resolved messages. `claude-comms.ts` does the file and git IO.
 *
 * Tag protocol (one or more per message, each at the start of a line):
 *   TASK: <id> <title>        a new task for the receiver
 *   ACK: <id>                 the receiver accepts it and starts
 *   STATUS: <id> <text>       progress
 *   BLOCKED: <id> <reason>
 *   DONE: <id> <summary>
 *   CANCELLED: <id> [reason]  the task is dropped (closed, not done)
 *   CLAIM: <path>[, <path>…]  the sender is now editing these files
 *   RELEASE: <path>[, …]      the sender no longer holds them
 *   COMMIT: <hash>[, <hash>…] commits the sender made
 *   PUSHED: <hash>            the branch is on the remote up to this hash
 * As we actually write them, also:
 *   - "TASK T12 <title>" (no colon), and a TASK after a short lead-in on its
 *     line ("Queued after T68: TASK T72 <title>"); the title is the rest of
 *     that line;
 *   - several ids in a report's first clause ("DONE: T53 and T54 (…)",
 *     "ACK: T53, T54"): it applies to each;
 *   - a report with no ACK before it (STATUS → in progress, DONE → done);
 *   - from a task's worker to its manager, an untagged message whose first
 *     line starts with the task's id ("T56 interim …") is progress on it.
 * Messages with no tag fall back to keyword guesses, marked `guessed`, but
 * only between two sessions that haven't used tags yet: once a pair sends its
 * first tagged message, prose no longer makes claims or tasks, and the
 * guessed tasks from before are dropped.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export const TAG_NAMES = [
  "TASK",
  "ACK",
  "STATUS",
  "BLOCKED",
  "DONE",
  "CANCELLED",
  "CLAIM",
  "RELEASE",
  "COMMIT",
  "PUSHED",
] as const;
export type TagName = (typeof TAG_NAMES)[number];
/** `loose`: a TASK found after a lead-in ("Queued after T68: TASK T72 …"), not at the line's start. */
export type CommsTag = { tag: TagName; arg: string; loose?: true };

export type CommsRole = "manager" | "worker" | "peer";

export type CommsNode = {
  /** `s:<sessionId>` for a known session, `x:<socket|name>` for one we only saw named. */
  key: string;
  sessionId: string | null;
  /** First 8 chars of the session id, or the socket's pid. */
  shortId: string;
  name: string;
  /** Names over time, oldest first (`at` = first seen). */
  names: { name: string; at: string | null }[];
  cwd: string | null;
  gitBranch: string | null;
  live: boolean;
  /** idle / busy / waiting, from the session registry while it runs. */
  status: string | null;
  /**
   * When its last turn ended by asking the user something in plain words (a "?" in the last
   * paragraph, not in code, quotes or links: lib/asking.ts) and it sits idle since; null otherwise.
   * AskUserQuestion and permission prompts show as status "waiting" instead.
   */
  asking: string | null;
  tmux: string | null;
  sockets: string[];
  role: CommsRole;
  sent: number;
  received: number;
  lastActivity: string | null;
  /** Every session merged under this name, the shown one first (a restart gives a new id). */
  sessions: string[];
  /** No chosen name (a dir-based default like "project-f7", or an id): not a team member. */
  guest: boolean;
};

export type DeliveryState = "delivered" | "queued" | "failed" | "sending" | "received";

export type CommsMessage = {
  id: string;
  from: string;
  to: string;
  sentAt: string | null;
  receivedAt: string | null;
  /** When the receiver's transcript is unknown we only know the send result. */
  state: DeliveryState;
  summary: string | null;
  body: string;
  truncated: boolean;
  tags: CommsTag[];
  /** Keyword guess for untagged messages (null when tagged or nothing matched). */
  guess: "dispatch" | "progress" | "done" | "blocked" | null;
};

export type TaskState = "dispatched" | "in_progress" | "blocked" | "done" | "cancelled";

/** Done or cancelled: no longer open. */
export const isClosed = (s: TaskState) => s === "done" || s === "cancelled";

export type CommsTask = {
  key: string;
  /** Protocol id (T12) or null for a guessed task. */
  id: string | null;
  title: string;
  manager: string;
  worker: string;
  state: TaskState;
  guessed: boolean;
  lastText: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  history: { state: TaskState; at: string | null; msgId: string; text: string | null }[];
  /**
   * Each owner's own state, when the task was given to more than one (the same id from the same
   * manager: "T92 (data part)" to one, "T92 (display part)" to another). `state` sums them up: done once
   * every part is (`summed`). Set once the task has a report; absent before.
   */
  parts?: Record<string, TaskState>;
};

export type FileClaim = {
  path: string;
  holder: string | null;
  since: string | null;
  guessed: boolean;
  history: {
    action: "claim" | "release";
    node: string;
    at: string | null;
    msgId: string;
    guessed: boolean;
  }[];
};

export type CommitMention = {
  hash: string;
  kind: "commit" | "pushed" | "mention";
  node: string;
  msgId: string;
  at: string | null;
};

export type CommitInfo = {
  hash: string;
  abbrev: string;
  subject: string | null;
  author: string | null;
  date: string | null;
  /** Remote branches containing it (null when unknown / unverified). */
  remotes: string[] | null;
  /** Admin project + app holding the repo, for linking to its git history. */
  project: string | null;
  app: string | null;
  /** The repo's top directory (the id Agents City's cities use); null when not known. */
  repo: string | null;
  verified: boolean;
  pushedTag: boolean;
  mentions: CommitMention[];
};

/** One tool call of a session. `file` only for Edit/MultiEdit/Write/NotebookEdit/Read. */
export type ActivityEvent = { t: string; tool: string; file: string | null };

export type CommsModel = {
  version: string;
  generatedAt: string;
  days: number;
  nodes: CommsNode[];
  messages: CommsMessage[];
  tasks: CommsTask[];
  files: FileClaim[];
  commits: CommitInfo[];
  /** Tool calls per node key; only when asked for (the 3D views). */
  activity?: Record<string, ActivityEvent[]>;
};

// ── Redaction ────────────────────────────────────────────────────────────────

const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  // user:password@ in URLs (postgres://, https://, …)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1***:***@"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{12,}=*/g, "$1 ***"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, "gh*_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza***"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "SG.***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"],
  // KEY=value / KEY: value where the name says it is a secret
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|ENC_KEY|DATABASE_URL|DSN)[A-Z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g,
    "$1$2***",
  ],
  // "password": "…" in JSON-ish text
  [
    /("(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|clientSecret|client_secret)"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  ],
];

/** Strip obvious credentials from a message before it leaves the server. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// ── Tags ─────────────────────────────────────────────────────────────────────

const TAG_RE = new RegExp(`^[ \\t>*_-]*(${TAG_NAMES.join("|")}):[ \\t]*(.*)$`);
/** T12, T12a, AB-3; "T44.7" is part 7 of T44. */
const ID = "[A-Za-z]{1,6}-?\\d+[a-z]?(?:\\.\\d+)?";
/** "TASK T72 …" / "TASK: T72 …", at the line's start or after a short lead-in ("Queued after T68: TASK T72 …"). */
const LOOSE_TASK_RE = new RegExp(`^(.{0,80}?)(?<![A-Za-z])TASK:?[ \\t]+(${ID})(?![\\w-])[:,.]?[ \\t]*(.*)$`);

export function parseTags(body: string): CommsTag[] {
  const tags: CommsTag[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(TAG_RE);
    if (m) {
      const arg = m[2].trim();
      // "TASK: <id> <title>" spells out the protocol; it isn't a task.
      if (/^<[^>]+>/.test(arg)) continue;
      tags.push({ tag: m[1] as TagName, arg });
      continue;
    }
    const t = line.match(LOOSE_TASK_RE);
    if (t) tags.push(t[1].trim() ? { tag: "TASK", arg: `${t[2]} ${t[3]}`.trim(), loose: true } : { tag: "TASK", arg: `${t[2]} ${t[3]}`.trim() });
  }
  return tags;
}

const TASK_ID_RE = new RegExp(`^${ID}$`);
/** Between ids, a note in brackets is still about the one before: "T92 (display part) + T101". */
const NOTE = `(?:\\s*\\([^()\\n]{0,80}\\))?`;
const IDS_RE = new RegExp(
  `^(${ID}(?:${NOTE}\\s*(?:,|&|\\+|/|\\band\\b)\\s*${ID})*)(?![\\w-])\\s*(?:[:,.]|[—–]|--?)?\\s*([\\s\\S]*)$`,
);

/**
 * Every id in a report's first clause and the rest: "T53 and T54 (both …)" →
 * ["T53", "T54"]; "T53, T54: done" → both; "T92 (display part) + T101, …" →
 * both (a note in brackets after an id stays with it); "T68 — …" → T68.
 * Empty if it doesn't start with one.
 */
export function splitTaskIds(arg: string): { ids: string[]; rest: string } {
  const m = arg.trim().match(IDS_RE);
  if (!m) return { ids: [], rest: arg.trim() };
  const ids = [
    ...new Set(
      m[1]
        .replace(/\s*\([^()]*\)/g, "")
        .split(/\s*(?:,|&|\+|\/|\band\b)\s*/)
        .map((x) => x.toUpperCase()),
    ),
  ];
  return { ids, rest: (m[2] ?? "").trim() };
}

/** Split "T12 rest of text" into an id and the rest; id null if it isn't one. */
export function splitTaskId(arg: string): { id: string | null; rest: string } {
  const m = arg.match(/^(\S+?)[:,.]?(?:\s+([\s\S]*))?$/);
  if (m && TASK_ID_RE.test(m[1])) return { id: m[1].toUpperCase(), rest: (m[2] ?? "").trim() };
  return { id: null, rest: arg.trim() };
}

function cleanPathToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"([{<]+|[`'")\]}>.:;]+$/g, "")
    .replace(/^\.\//, "");
}

/** `a.ts, src/b.ts (notes)` → ["a.ts", "src/b.ts"]: first token of each item. */
export function splitPaths(arg: string): string[] {
  const out: string[] = [];
  for (const item of arg.split(/[,;]/)) {
    const first = cleanPathToken(item.trim().split(/\s+/)[0] ?? "");
    if (first && /[\w]/.test(first) && first.length <= 300) out.push(first);
  }
  return out;
}

const HEX_RE = /^[0-9a-f]{7,40}$/i;

export function splitHashes(arg: string): string[] {
  return arg
    .split(/[\s,;]+/)
    .map((t) => cleanPathToken(t).toLowerCase())
    .filter((t) => HEX_RE.test(t));
}

// ── Fallbacks for untagged messages ──────────────────────────────────────────

const PATH_RE =
  /(?:^|[\s`'"(\[])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|sql|py|sh|ya?ml|toml|go|rs|html|prisma))(?=$|[\s`'"),:;\]!?]|\.(?:\s|$))/g;

export function findPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = cleanPathToken(m[1]);
    // Skip URLs' tails and version-ish things.
    if (p && !/^\d/.test(p) && !p.includes("://")) out.add(p);
  }
  return [...out];
}

/** Hex words that look like abbreviated commit hashes (need a digit and a letter). */
export function findHashes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/-])([0-9a-f]{7,40})(?![\w-])/g)) {
    const h = m[1];
    if (/\d/.test(h) && /[a-f]/.test(h)) out.add(h);
  }
  return [...out];
}

const RELEASE_TO_RECEIVER_RE =
  /\b(?:(?:is|are|it'?s|they'?re) (?:all )?yours(?: now| again)?|all yours|over to you|hand(?:ing|ed)? (?:it|them|this|these) (?:back|over)|you can (?:have|take) (?:it|them))\b/i;
const RELEASE_RE =
  /\b(?:done with|finished with|releas(?:e|ed|ing)|no longer (?:editing|touching|working on|changing)|not touching|stopped editing|free(?:d)? up|let go of)\b/i;
const CLAIM_RE =
  /\b(?:i'?m (?:also |now |still |currently )?(?:editing|changing|working on|touching|modifying|rewriting)|i (?:am|will|'ll) (?:edit|take|change|work on|touch|modify)|i'?m taking|claim(?:ing|ed)?|(?:it'?s|they'?re) mine|mine (?:now|for now)|please (?:don'?t|do not) (?:touch|edit|change))\b/i;

const DONE_RE =
  /\b(?:done|finished|completed?|committed|pushed|landed|merged|shipped|implemented|all set)\b/i;
const BLOCKED_RE =
  /\b(?:blocked|stuck|can'?t|cannot|unable to|waiting (?:on|for)|need (?:you|your|the user|permission)|was denied|permission denied|fails? to)\b/i;
const REQUEST_RE =
  /\b(?:please|can you|could you|would you|i'?d like you to|your (?:task|job) is|go ahead and|take over|over to you to|i'?m (?:delegating|assigning|handing you)|next task)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n+/).filter((s) => s.trim());
}

type FileAction = { path: string; action: "claim" | "release"; who: "sender" | "receiver" };

/** Guess claims/releases from prose, sentence by sentence. */
export function guessFileActions(body: string): FileAction[] {
  const out: FileAction[] = [];
  for (const s of sentences(body)) {
    const paths = findPaths(s);
    if (paths.length === 0) continue;
    if (RELEASE_TO_RECEIVER_RE.test(s)) {
      for (const p of paths) {
        out.push({ path: p, action: "release", who: "sender" });
        out.push({ path: p, action: "claim", who: "receiver" });
      }
    } else if (RELEASE_RE.test(s)) {
      for (const p of paths) out.push({ path: p, action: "release", who: "sender" });
    } else if (CLAIM_RE.test(s)) {
      for (const p of paths) out.push({ path: p, action: "claim", who: "sender" });
    }
  }
  return out;
}

// ── One agent per name ───────────────────────────────────────────────────────

/**
 * A name nobody chose: the session id's prefix, "pid 123", a raw socket, or
 * Claude Code's dir-based default ("project-f7" for a session in /opt/project).
 */
export function isDefaultName(name: string, cwd: string | null, sessionId: string | null): boolean {
  if (sessionId && name === sessionId.slice(0, 8)) return true;
  if (/^pid \d+$/.test(name) || name.startsWith("uds:") || name === "?") return true;
  const base = cwd?.split("/").filter(Boolean).pop();
  if (!base) return false;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}-[0-9a-z]{1,6}$`, "i").test(name);
}

const byShown = (a: CommsNode, b: CommsNode) =>
  Number(b.live) - Number(a.live) || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");

/**
 * Merge the nodes that share a name into one agent: the live session (else the
 * latest active) is shown and keeps its key, so panes and registry lookups by
 * `s:<sessionId>` still work; the others are ended sessions whose history
 * joins it. Names nobody chose (ids, pids) are never merged. `keyOf` maps every
 * input key to its merged key.
 */
/**
 * Who a SendMessage reached, from its result ("“…” → Bob (another Claude session on this machine; …)",
 * also "→ Bob [6cc30e] (…"): the name a socket address had when it was sent to, which survives the
 * registry (a reboot empties it). Null when the result doesn't say.
 */
export function recipientName(resultMessage: string): string | null {
  const m = resultMessage.match(/→\s*([^\n(\[]+?)\s*(?:\[[0-9a-f]+\]\s*)?\(/);
  const name = m?.[1].trim();
  return name && !name.startsWith("uds:") && name.length <= 60 ? name : null;
}

/**
 * A session's name from its own first prompt, for an ended one whose registry entry is gone (a reboot):
 * the team's recipe starts "You are <Name>, …" (team.md). Conservative: a capitalised word right after
 * "You are" and followed by "," "." or " —", not "Claude"; else null.
 */
export function nameFromPrompt(text: string): string | null {
  const m = text.trimStart().match(/^You are ([A-Z][A-Za-z0-9_-]{0,30})(?=\s*(?:[,.]|—|-\s))/);
  return m && m[1] !== "Claude" ? m[1] : null;
}

/**
 * The nodes worth listing for a window: live ones, and those with a message, a tool call or a task in it.
 * A session seen only in older lines of a file that is still being written (e.g. a pre-reboot peer's
 * socket, "pid 14604") has nothing in the window and isn't listed.
 */
export function nodesInWindow(
  nodes: CommsNode[],
  windowed: CommsMessage[],
  tasks: CommsTask[],
  cutoff: string,
  activity?: Record<string, unknown[]>,
): CommsNode[] {
  const seen = new Set<string>();
  for (const m of windowed) seen.add(m.from).add(m.to);
  for (const t of tasks)
    if ((t.updatedAt ?? "") >= cutoff) for (const k of [t.manager, t.worker, ...Object.keys(t.parts ?? {})]) seen.add(k);
  return nodes.filter((n) => n.live || seen.has(n.key) || !!activity?.[n.key]?.length);
}

export function mergeNodesByName(input: CommsNode[]): { nodes: CommsNode[]; keyOf: Map<string, string> } {
  const groups = new Map<string, CommsNode[]>();
  const out: CommsNode[] = [];
  const keyOf = new Map<string, string>();
  for (const n of input) {
    if (n.name === n.shortId || isDefaultName(n.name, null, n.sessionId)) {
      out.push({ ...n, sessions: n.sessionId ? [n.sessionId] : [], guest: true });
      keyOf.set(n.key, n.key);
      continue;
    }
    const g = groups.get(n.name) ?? [];
    g.push(n);
    groups.set(n.name, g);
  }
  for (const [name, g] of groups) {
    const [shown, ...rest] = [...g].sort(byShown);
    const all = [shown, ...rest];
    const names: { name: string; at: string | null }[] = [];
    for (const e of all.flatMap((n) => n.names).sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")))
      if (names.length === 0 || names[names.length - 1].name !== e.name) names.push(e);
    const cwd = shown.cwd ?? rest.find((n) => n.cwd)?.cwd ?? null;
    out.push({
      ...shown,
      cwd,
      names: rest.length ? names : shown.names,
      sockets: [...new Set(all.flatMap((n) => n.sockets))],
      sent: all.reduce((s, n) => s + n.sent, 0),
      received: all.reduce((s, n) => s + n.received, 0),
      lastActivity: all.map((n) => n.lastActivity).reduce((a, b) => ((b ?? "") > (a ?? "") ? b : a), null),
      sessions: all.map((n) => n.sessionId).filter((x): x is string => !!x),
      guest: all.some((n) => n.guest) || isDefaultName(name, cwd, shown.sessionId),
    });
    for (const n of all) keyOf.set(n.key, shown.key);
  }
  return { nodes: out, keyOf };
}

// ── Derivation ───────────────────────────────────────────────────────────────

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const byTime = (a: CommsMessage, b: CommsMessage) =>
  (a.sentAt ?? a.receivedAt ?? "").localeCompare(b.sentAt ?? b.receivedAt ?? "");

/**
 * Walk the messages in time order and derive tasks, file claims and commit
 * mentions. Mutates each message's `guess`. Messages must already be resolved
 * to node keys and redacted.
 */
export function deriveState(messages: CommsMessage[]): {
  tasks: CommsTask[];
  files: FileClaim[];
  mentions: CommitMention[];
} {
  const tasks = new Map<string, CommsTask>();
  const files = new Map<string, FileClaim>();
  const mentions: CommitMention[] = [];

  /** Each owner's state (a task given to one owner has just that one). */
  const partsOf = (t: CommsTask): Record<string, TaskState> => (t.parts ??= { [t.worker]: t.state });
  const owns = (t: CommsTask, node: string) => node === t.worker || (!!t.parts && node in t.parts);
  const findTask = (id: string, a: string, b: string): CommsTask | undefined => {
    // Prefer a task between this pair (its manager and one of its owners); else one with that id that
    // involves either (a helper reporting to the manager on someone else's task).
    let fallback: CommsTask | undefined;
    for (const t of tasks.values()) {
      if (t.id !== id) continue;
      if ((t.manager === a && owns(t, b)) || (t.manager === b && owns(t, a))) return t;
      if (!fallback && (t.manager === a || t.manager === b || owns(t, a) || owns(t, b))) fallback = t;
    }
    return fallback;
  };
  /** Latest open task (its part still open) where `worker` works for `manager`. */
  const openTask = (manager: string, worker: string, guessedOnly = false) => {
    let found: CommsTask | undefined;
    for (const t of tasks.values()) {
      if (t.manager === manager && owns(t, worker) && !isClosed(t.parts?.[worker] ?? t.state)) {
        if (guessedOnly && !t.guessed) continue;
        if (!found || (t.updatedAt ?? "") >= (found.updatedAt ?? "")) found = t;
      }
    }
    return found;
  };
  const move = (t: CommsTask, state: TaskState, m: CommsMessage, text: string | null) => {
    const at = m.sentAt ?? m.receivedAt;
    t.state = state;
    t.updatedAt = at;
    if (text) t.lastText = text;
    t.history.push({ state, at, msgId: m.id, text });
  };

  /**
   * A tagged report from one of the task's owners (their part) or its manager (every part). A done part
   * stays done: a later ACK/STATUS (e.g. the manager's review) is kept in the history but doesn't reopen
   * it; only BLOCKED or a TASK that says "resume" does. A cancelled one only reopens on TASK.
   */
  const report = (t: CommsTask, tag: ReportTag, m: CommsMessage, text: string) => {
    const next = (cur: TaskState): TaskState =>
      cur === "cancelled" && tag !== "DONE" ? "cancelled" : cur === "done" && (tag === "ACK" || tag === "STATUS") ? "done" : tagState(tag);
    const parts = partsOf(t);
    if (m.from in parts) parts[m.from] = next(parts[m.from]);
    else for (const w of Object.keys(parts)) parts[w] = next(parts[w]);
    move(t, summed(parts), m, text || null);
  };

  // Basename → full paths seen, so "x.ts is yours now" can match "src/lib/x.ts".
  const fullPaths = new Map<string, Set<string>>();
  const canonical = (p: string): string => {
    if (p.includes("/")) {
      const base = p.split("/").pop()!;
      if (!fullPaths.has(base)) fullPaths.set(base, new Set());
      fullPaths.get(base)!.add(p);
      return p;
    }
    const full = fullPaths.get(p);
    return full && full.size === 1 ? [...full][0] : p;
  };
  const fileAct = (
    rawPath: string,
    action: "claim" | "release",
    node: string,
    m: CommsMessage,
    guessed: boolean,
  ) => {
    const p = canonical(rawPath);
    let f = files.get(p);
    if (!f) {
      f = { path: p, holder: null, since: null, guessed, history: [] };
      files.set(p, f);
    }
    const at = m.sentAt ?? m.receivedAt;
    f.history.push({ action, node, at, msgId: m.id, guessed });
    if (action === "claim") {
      f.holder = node;
      f.since = at;
      f.guessed = guessed;
    } else if (f.holder === node || f.holder === null) {
      f.holder = null;
      f.since = at;
      f.guessed = guessed;
    }
  };

  const sorted = [...messages].sort(byTime);
  // When each pair of sessions started using tags.
  const tagsSince = new Map<string, string>();
  for (const m of sorted) {
    const at = m.sentAt ?? m.receivedAt;
    const k = pairKey(m.from, m.to);
    if (m.tags.length > 0 && at && !tagsSince.has(k)) tagsSince.set(k, at);
  }

  const adopted = new Set<string>();
  for (const m of sorted) {
    const at = m.sentAt ?? m.receivedAt;
    if (m.tags.length > 0) {
      // The pair's first tagged message: its earlier prose guesses about who
      // holds what are stale, so end them (guessed releases).
      const pk = pairKey(m.from, m.to);
      if (!adopted.has(pk)) {
        adopted.add(pk);
        for (const f of files.values())
          for (const node of [m.from, m.to])
            if (f.history.some((h) => h.guessed && h.action === "claim" && h.node === node))
              fileAct(f.path, "release", node, m, true);
      }
      for (const { tag, arg, loose } of m.tags) {
        switch (tag) {
          case "TASK": {
            const { id, rest } = splitTaskId(arg);
            const key = `${id ?? m.id}@${m.from}`;
            const known = tasks.get(key);
            if (known) {
              // The same id again: to a new owner, another part of it ("T92 (display part)"); to an owner,
              // a re-send (after a restart, a reminder) that keeps their part as it is. A done part reopens
              // only when told to resume; a cancelled one always does. A loose mention ("I've dispatched
              // TASK T3 to Bob", told to someone else) never makes a new owner.
              const parts = partsOf(known);
              const cur = parts[m.to];
              if (cur === undefined && loose) break;
              parts[m.to] =
                cur === undefined || cur === "cancelled" ? "dispatched" : cur === "done" ? (/\bresume\b/i.test(rest) ? "dispatched" : "done") : cur;
              move(known, summed(parts), m, rest || null);
              break;
            }
            const t: CommsTask = {
              key,
              id,
              title: rest || m.summary || firstLine(m.body),
              manager: m.from,
              worker: m.to,
              state: "dispatched",
              guessed: false,
              lastText: null,
              createdAt: at,
              updatedAt: at,
              history: [],
            };
            tasks.set(key, t);
            move(t, "dispatched", m, rest || null);
            break;
          }
          case "ACK":
          case "STATUS":
          case "BLOCKED":
          case "DONE":
          case "CANCELLED": {
            const { ids, rest } = splitTaskIds(arg);
            if (ids.length === 0) {
              // Only an id right after the tag closes a task; without one, an
              // ACK / STATUS / BLOCKED is about the latest open task the sender
              // works on for the receiver.
              if (tag === "DONE" || tag === "CANCELLED") break;
              const t = openTask(m.to, m.from);
              if (t) report(t, tag, m, rest);
              break;
            }
            for (const raw of ids) {
              // "DONE: T44.7 …" finishes part 7 of T44: progress on T44, not its end.
              const part = /\.\d+$/.test(raw);
              const id = part ? raw.replace(/\.\d+$/, "") : raw;
              const eff = part && (tag === "DONE" || tag === "CANCELLED") ? "STATUS" : tag;
              const text = part ? `${raw} ${rest}`.trim() : rest;
              const t = findTask(id, m.from, m.to);
              if (!t) {
                // A report on a task we never saw dispatched (older than the window).
                const key = `${id}@${m.to}`;
                const nt: CommsTask = {
                  key,
                  id,
                  title: (part ? "" : rest) || m.summary || id,
                  manager: m.to,
                  worker: m.from,
                  state: "dispatched",
                  guessed: false,
                  lastText: null,
                  createdAt: at,
                  updatedAt: at,
                  history: [],
                };
                tasks.set(key, nt);
                move(nt, tagState(eff), m, text || null);
              } else if (owns(t, m.from) || m.from === t.manager) {
                report(t, eff, m, text);
              }
              // From anyone else (a helper's "DONE: T74" for their part of
              // someone's task) the state stays the owner's; the message still
              // shows in the task's thread, which lists every message naming it.
            }
            break;
          }
          case "CLAIM":
            for (const p of splitPaths(arg)) fileAct(p, "claim", m.from, m, false);
            break;
          case "RELEASE":
            for (const p of splitPaths(arg)) fileAct(p, "release", m.from, m, false);
            break;
          case "COMMIT":
          case "PUSHED":
            for (const h of splitHashes(arg))
              mentions.push({
                hash: h,
                kind: tag === "COMMIT" ? "commit" : "pushed",
                node: m.from,
                msgId: m.id,
                at,
              });
            // The manager committing an owner's work and telling them ("COMMIT: a4414f6 / PUSHED (T110)"
            // after "BLOCKED: T110 commit/push"; "COMMIT: ca7e185 (T90): your Table work is on origin")
            // finishes that owner's part, blocked or in progress. Only the receiver's: a commit of one
            // part ("(T92 data part)", to Alex) leaves another owner's part as it is.
            for (const id of idsIn(arg)) {
              const t = tasks.get(`${id}@${m.from}`);
              if (!t || !owns(t, m.to)) continue;
              const parts = partsOf(t);
              if (parts[m.to] !== "blocked" && parts[m.to] !== "in_progress") continue;
              parts[m.to] = "done";
              move(t, summed(parts), m, `${tag}: ${arg}`.slice(0, 200));
            }
            break;
        }
      }
      continue;
    }

    for (const h of findHashes(m.body))
      mentions.push({ hash: h, kind: "mention", node: m.from, msgId: m.id, at });
    // "T56 interim …" from the task's worker to its manager: progress on it,
    // even once the pair uses tags (it only starts a task, never closes one).
    {
      const lead = splitTaskIds(firstLine(m.body));
      for (const id of lead.ids) {
        const t = findTask(id, m.from, m.to);
        if (t && t.manager === m.to && owns(t, m.from) && partsOf(t)[m.from] === "dispatched") {
          partsOf(t)[m.from] = "in_progress";
          move(t, summed(partsOf(t)), m, firstLine(m.body));
        }
      }
    }
    // Untagged: keyword fallbacks, all marked as guesses, only while this pair
    // hasn't started using tags.
    const since = tagsSince.get(pairKey(m.from, m.to));
    if (since && at && at >= since) continue;
    for (const fa of guessFileActions(m.body)) {
      fileAct(fa.path, fa.action, fa.who === "sender" ? m.from : m.to, m, true);
    }

    const text = m.summary || firstLine(m.body);
    const open = openTask(m.to, m.from, true);
    if (open && BLOCKED_RE.test(m.body)) {
      m.guess = "blocked";
      move(open, "blocked", m, text);
    } else if (open && DONE_RE.test(m.body)) {
      m.guess = "done";
      move(open, "done", m, text);
    } else if (REQUEST_RE.test(m.body)) {
      m.guess = "dispatch";
      const key = `${m.id}@${m.from}`;
      const t: CommsTask = {
        key,
        id: null,
        title: text,
        manager: m.from,
        worker: m.to,
        state: "dispatched",
        guessed: true,
        lastText: null,
        createdAt: at,
        updatedAt: at,
        history: [],
      };
      tasks.set(key, t);
      move(t, "dispatched", m, null);
    } else if (open) {
      m.guess = "progress";
      move(open, "in_progress", m, text);
    }
  }

  const fileList = [...files.values()].sort((a, b) =>
    (b.since ?? "").localeCompare(a.since ?? ""),
  );
  // Guessed tasks of a pair that later used tags are superseded by the tagged ones.
  const taskList = [...tasks.values()]
    .filter((t) => !(t.guessed && tagsSince.has(pairKey(t.manager, t.worker))))
    .sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  return { tasks: taskList, files: fileList, mentions };
}

type ReportTag = "ACK" | "STATUS" | "BLOCKED" | "DONE" | "CANCELLED";

/**
 * A task's state from its owners' parts: done (or cancelled) once every part is closed, blocked while any
 * is, in progress once any has started (or finished), else dispatched.
 */
export function summed(parts: Record<string, TaskState>): TaskState {
  const s = Object.values(parts);
  if (s.every(isClosed)) return s.includes("done") ? "done" : "cancelled";
  if (s.includes("blocked")) return "blocked";
  if (s.some((x) => x === "in_progress" || x === "done")) return "in_progress";
  return "dispatched";
}

const ID_IN_RE = new RegExp(`(?<![\\w-])(${ID})(?![\\w-])`, "g");
/** Every task-id-looking word in a text (whether it is one is up to the caller: it must name a task). */
function idsIn(text: string): string[] {
  return [...new Set([...text.matchAll(ID_IN_RE)].map((x) => x[1].toUpperCase()))];
}

function tagState(tag: ReportTag): TaskState {
  return tag === "DONE" ? "done" : tag === "CANCELLED" ? "cancelled" : tag === "BLOCKED" ? "blocked" : "in_progress";
}

/** Manager = hands out more tasks than it takes; worker = the reverse. */
export function assignRoles(nodes: CommsNode[], tasks: CommsTask[]): void {
  const given = new Map<string, number>();
  const taken = new Map<string, number>();
  for (const t of tasks) {
    given.set(t.manager, (given.get(t.manager) ?? 0) + (t.guessed ? 1 : 3));
    taken.set(t.worker, (taken.get(t.worker) ?? 0) + (t.guessed ? 1 : 3));
  }
  for (const n of nodes) {
    const g = given.get(n.key) ?? 0;
    const k = taken.get(n.key) ?? 0;
    n.role = g > k ? "manager" : k > g ? "worker" : "peer";
  }
}
