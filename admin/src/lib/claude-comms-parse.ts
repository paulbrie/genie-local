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
 *   CLAIM: <path>[, <path>…]  the sender is now editing these files
 *   RELEASE: <path>[, …]      the sender no longer holds them
 *   COMMIT: <hash>[, <hash>…] commits the sender made
 *   PUSHED: <hash>            the branch is on the remote up to this hash
 * Messages with no tag fall back to keyword guesses, marked `guessed`.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export const TAG_NAMES = [
  "TASK",
  "ACK",
  "STATUS",
  "BLOCKED",
  "DONE",
  "CLAIM",
  "RELEASE",
  "COMMIT",
  "PUSHED",
] as const;
export type TagName = (typeof TAG_NAMES)[number];
export type CommsTag = { tag: TagName; arg: string };

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
  tmux: string | null;
  sockets: string[];
  role: CommsRole;
  sent: number;
  received: number;
  lastActivity: string | null;
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

export type TaskState = "dispatched" | "in_progress" | "blocked" | "done";

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

const TAG_RE = new RegExp(`^[ \\t>*_-]*(${TAG_NAMES.join("|")}):[ \\t]*(.*)$`, "gm");

export function parseTags(body: string): CommsTag[] {
  const tags: CommsTag[] = [];
  for (const m of body.matchAll(TAG_RE)) {
    const arg = m[2].trim();
    // "TASK: <id> <title>" spells out the protocol; it isn't a task.
    if (/^<[^>]+>/.test(arg)) continue;
    tags.push({ tag: m[1] as TagName, arg });
  }
  return tags;
}

const TASK_ID_RE = /^[A-Za-z]{1,6}-?\d+[a-z]?$/;

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

  const findTask = (id: string, a: string, b: string): CommsTask | undefined => {
    // Prefer a task between this pair; else any task with that id that involves a.
    let fallback: CommsTask | undefined;
    for (const t of tasks.values()) {
      if (t.id !== id) continue;
      const pair = pairKey(t.manager, t.worker);
      if (pair === pairKey(a, b)) return t;
      if (!fallback && (t.manager === a || t.worker === a)) fallback = t;
    }
    return fallback;
  };
  /** Latest open task where `worker` works for `manager`. */
  const openTask = (manager: string, worker: string, guessedOnly = false) => {
    let found: CommsTask | undefined;
    for (const t of tasks.values()) {
      if (t.manager === manager && t.worker === worker && t.state !== "done") {
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

  for (const m of [...messages].sort(byTime)) {
    const at = m.sentAt ?? m.receivedAt;
    if (m.tags.length > 0) {
      for (const { tag, arg } of m.tags) {
        switch (tag) {
          case "TASK": {
            const { id, rest } = splitTaskId(arg);
            const key = `${id ?? m.id}@${m.from}`;
            const t: CommsTask = tasks.get(key) ?? {
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
          case "DONE": {
            const { id, rest } = splitTaskId(arg);
            // Without an id: the latest open task the sender works on for the receiver.
            const t = id ? findTask(id, m.from, m.to) : openTask(m.to, m.from);
            if (!t && id) {
              // A report on a task we never saw dispatched (older than the window).
              const key = `${id}@${m.to}`;
              const nt: CommsTask = {
                key,
                id,
                title: rest || m.summary || id,
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
              move(nt, tagState(tag), m, rest || null);
            } else if (t) {
              // A done task stays done: a later ACK/STATUS (e.g. the manager's
              // review) is kept in its history but doesn't reopen it. Only
              // BLOCKED or a new TASK does.
              const next = t.state === "done" && (tag === "ACK" || tag === "STATUS") ? "done" : tagState(tag);
              move(t, next, m, rest || null);
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
            break;
        }
      }
      continue;
    }

    // Untagged: keyword fallbacks, all marked as guesses.
    for (const fa of guessFileActions(m.body)) {
      fileAct(fa.path, fa.action, fa.who === "sender" ? m.from : m.to, m, true);
    }
    for (const h of findHashes(m.body))
      mentions.push({ hash: h, kind: "mention", node: m.from, msgId: m.id, at });

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
  const taskList = [...tasks.values()].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  return { tasks: taskList, files: fileList, mentions };
}

function tagState(tag: "ACK" | "STATUS" | "BLOCKED" | "DONE"): TaskState {
  return tag === "DONE" ? "done" : tag === "BLOCKED" ? "blocked" : "in_progress";
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
