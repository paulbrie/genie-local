import "server-only";

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { CLAUDE_HOME } from "@/lib/claude";
import {
  type ActivityEvent,
  assignRoles,
  type CommitInfo,
  type CommitMention,
  type CommsMessage,
  type CommsModel,
  type CommsNode,
  deriveState,
  parseTags,
  redact,
} from "@/lib/claude-comms-parse";
import { PROJECTS_ROOT } from "@/lib/signals";

/**
 * Session-to-session messages (the SendMessage tool over /tmp/cc-socks) read
 * out of Claude Code transcripts. Read-only: transcripts are tailed
 * incrementally and only SendMessage calls, their results, incoming
 * <cross-session-message> entries and /rename outputs are kept — nothing else
 * from a transcript leaves this module, and message text is redacted.
 *
 * Identity: a session is its transcript (session uuid). Sockets are mapped to
 * sessions through the live registry (~/.claude/sessions/<pid>.json, only
 * whitelisted fields; the .key files there are never opened) and through
 * msg_id pairs: the sender's tool result and the receiver's incoming entry
 * carry the same msg_id.
 */

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");
const REGISTRY_DIR = path.join(CLAUDE_HOME, "sessions");
const CHUNK = 4 * 1024 * 1024;
const MAX_BODY = 32 * 1024;
const MAX_DAYS = 60;
export const DEFAULT_DAYS = 7;
/** Latest tool calls kept per session in the activity stream. */
const MAX_ACTIVITY = 20_000;

// Only lines containing one of these can matter; the rest are never JSON-parsed.
const NEEDLES = [
  '"SendMessage"',
  '"kind":"peer"',
  "cross-session-message",
  '"msg_id"',
  "Session renamed to",
  '"tool_use"',
];

// Tools whose file_path is kept in the activity stream; nothing else of a tool's input is.
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Read"]);

// ── Raw records per transcript ───────────────────────────────────────────────

type RawOut = {
  toolUseId: string;
  ts: string | null;
  to: string;
  summary: string | null;
  body: string;
  msgId: string | null;
  result: "delivered" | "queued" | "failed" | null;
};

type RawIn = {
  ts: string | null;
  from: string;
  fromName: string | null;
  msgId: string | null;
  body: string;
};

type FileState = {
  abs: string;
  sessionId: string;
  ino: number;
  offset: number;
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  lastTs: string | null;
  outs: Map<string, RawOut>;
  ins: RawIn[];
  seenIn: Set<string>;
  renames: { name: string; ts: string | null }[];
  /** Every tool call, oldest first (file only for FILE_TOOLS). */
  activity: ActivityEvent[];
};

const fileStates = new Map<string, FileState>();

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const INCOMING_RE =
  /<cross-session-message\s+from="([^"]*)"(?:\s+from-name="([^"]*)")?[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/;

function resultState(r: Record<string, unknown>): RawOut["result"] {
  if (r.success === false) return "failed";
  const msg = str(r.message) ?? "";
  return /\bqueued\b/i.test(msg) ? "queued" : "delivered";
}

function ingestLine(st: FileState, line: string): void {
  if (!NEEDLES.some((n) => line.includes(n))) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!obj || typeof obj !== "object") return;
  const ts = str(obj.timestamp);
  if (str(obj.cwd)) st.cwd = obj.cwd as string;
  if (str(obj.gitBranch)) st.gitBranch = obj.gitBranch as string;
  if (ts && (!st.lastTs || ts > st.lastTs)) st.lastTs = ts;
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;

  if (obj.type === "assistant" && Array.isArray(content)) {
    for (const raw of content) {
      const b = raw as Record<string, unknown>;
      if (b?.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const tool = str(b.name) ?? "tool";
      if (ts) {
        const file = FILE_TOOLS.has(tool) ? (str(input.file_path) ?? str(input.notebook_path)) : null;
        st.activity.push({ t: ts, tool, file });
      }
      if (tool !== "SendMessage") continue;
      const to = str(input.to) ?? str(input.recipient);
      const body = str(input.message) ?? str(input.content) ?? "";
      if (!to || !body) continue; // pure idle subscriptions carry no message
      st.outs.set(String(b.id), {
        toolUseId: String(b.id),
        ts,
        to,
        summary: str(input.summary),
        body,
        msgId: null,
        result: null,
      });
    }
    return;
  }

  if (obj.type === "user" && Array.isArray(content)) {
    for (const raw of content) {
      const b = raw as Record<string, unknown>;
      if (b?.type !== "tool_result") continue;
      const out = st.outs.get(String(b.tool_use_id));
      if (!out) continue;
      const r = obj.toolUseResult;
      if (r && typeof r === "object") {
        const rec = r as Record<string, unknown>;
        out.msgId = str(rec.msg_id);
        out.result = resultState(rec);
      } else {
        out.result = b.is_error ? "failed" : "delivered";
      }
    }
  }

  // Incoming messages land as a user turn when the session is idle, or inside
  // another entry (e.g. an attachment) when it arrives mid-turn, so look for the
  // peer origin / the wrapper anywhere in the entry except its tool calls.
  const { origin, text } = findIncoming(obj);
  const wrapped = text?.match(INCOMING_RE);
  const from = str(origin?.from) ?? wrapped?.[1] ?? null;
  // Peers without a transport prefix (uds:…) are in-process subagents.
  if (from && from.includes(":")) {
    const msgId = str(origin?.msg_id);
    const body = str(origin?.body) ?? wrapped?.[3] ?? text ?? "";
    const dedupe = msgId ?? `${from}\n${body}`;
    if (!st.seenIn.has(dedupe)) {
      st.seenIn.add(dedupe);
      st.ins.push({ ts, from, fromName: str(origin?.name) ?? wrapped?.[2] ?? null, msgId, body });
    }
    return;
  }
  if (obj.type === "user" && typeof content === "string") {
    const rn = content.match(/Session renamed to:\s*([^<\n]+)/);
    if (rn && content.includes("local-command-stdout"))
      st.renames.push({ name: rn[1].trim(), ts });
  }
}

const PEER_INTRO = "Another Claude session sent a message";

function findIncoming(obj: Record<string, unknown>): {
  origin: Record<string, unknown> | null;
  text: string | null;
} {
  let origin: Record<string, unknown> | null = null;
  let text: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || (origin && text)) return;
    if (typeof v === "string") {
      if (!text && v.includes(PEER_INTRO) && v.includes("<cross-session-message")) text = v;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "tool_result" || o.type === "tool_use") return;
      if (!origin && o.kind === "peer" && typeof o.from === "string") origin = o;
      for (const [k, x] of Object.entries(o)) if (k !== "toolUseResult") walk(x, depth + 1);
    }
  };
  walk(obj, 0);
  return { origin, text };
}

/** Read whatever was appended since the last call (whole file the first time). */
async function refreshFile(abs: string, sessionId: string): Promise<FileState | null> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    fileStates.delete(abs);
    return null;
  }
  let st = fileStates.get(abs);
  if (!st || st.ino !== stat.ino || stat.size < st.offset) {
    st = {
      abs,
      sessionId,
      ino: stat.ino,
      offset: 0,
      mtimeMs: 0,
      cwd: null,
      gitBranch: null,
      lastTs: null,
      outs: new Map(),
      ins: [],
      seenIn: new Set(),
      renames: [],
      activity: [],
    };
    fileStates.set(abs, st);
  }
  if (stat.size === st.offset) {
    st.mtimeMs = stat.mtimeMs;
    return st;
  }

  const handle = await fs.open(abs, "r");
  try {
    let pos = st.offset;
    let carry = Buffer.alloc(0);
    while (pos < stat.size) {
      const len = Math.min(CHUNK, stat.size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        carry = data;
        continue;
      }
      for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) {
        if (line) ingestLine(st, line);
      }
      carry = data.subarray(lastNl + 1);
    }
    // A trailing partial line is re-read next time.
    st.offset = pos - carry.length;
    st.mtimeMs = stat.mtimeMs;
  } finally {
    await handle.close();
  }
  return st;
}

// ── Live registry ────────────────────────────────────────────────────────────

export type RegistryEntry = {
  pid: number;
  sessionId: string;
  name: string | null;
  status: string | null;
  tmux: string | null;
  socket: string | null;
  cwd: string | null;
  nameSince: number | null;
  updatedAt: number | null;
};

export async function readRegistry(): Promise<{ entries: RegistryEntry[]; sig: string }> {
  let names: string[];
  try {
    names = (await fs.readdir(REGISTRY_DIR)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return { entries: [], sig: "" };
  }
  const entries: RegistryEntry[] = [];
  const sig: string[] = [];
  await Promise.all(
    names.map(async (f) => {
      try {
        const d = JSON.parse(await fs.readFile(path.join(REGISTRY_DIR, f), "utf8"));
        const pid = Number(d.pid);
        if (!pid || typeof d.sessionId !== "string") return;
        if (!isAlive(pid)) return; // stale file from a crashed session
        const socket = str(d.messagingSocketPath);
        entries.push({
          pid,
          sessionId: d.sessionId,
          name: str(d.name),
          status: str(d.status),
          tmux: str(d.tmux),
          socket: socket ? `uds:${socket}` : null,
          cwd: str(d.cwd),
          nameSince: typeof d.nameSince === "number" ? d.nameSince : null,
          updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null,
        });
        sig.push(`${pid}:${d.status}:${d.name}`);
      } catch {
        /* half-written or vanished */
      }
    }),
  );
  return { entries, sig: sig.sort().join(",") };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── Git verification of mentioned hashes ─────────────────────────────────────

export type RepoInfo = { top: string; project: string | null; app: string | null };
const repoByCwd = new Map<string, RepoInfo | null>();
type CachedCommit = {
  info: Omit<CommitInfo, "mentions" | "pushedTag"> | null;
  checkedAt: number;
};
const commitCache = new Map<string, CachedCommit>();
const MISS_TTL = 60_000;
const REMOTES_TTL = 60_000;

export async function repoFor(cwd: string): Promise<RepoInfo | null> {
  if (repoByCwd.has(cwd)) return repoByCwd.get(cwd)!;
  let info: RepoInfo | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    const rel = path.relative(path.resolve(PROJECTS_ROOT), top);
    let project: string | null = null;
    let app: string | null = null;
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const parts = rel.split(path.sep);
      if (parts.length === 1) [project, app] = [parts[0], ""];
      else if (parts.length === 2) [project, app] = parts;
    }
    info = { top, project, app };
  } catch {
    info = null;
  }
  repoByCwd.set(cwd, info);
  return info;
}

function gitBatchCheck(top: string, hashes: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const out = new Map<string, string>();
    const child = spawn("git", ["-C", top, "cat-file", "--batch-check=%(objectname) %(objecttype)"]);
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.on("error", () => resolve(out));
    child.on("close", () => {
      const lines = buf.split("\n");
      hashes.forEach((h, i) => {
        const [full, type] = (lines[i] ?? "").split(" ");
        if (type === "commit") out.set(h, full);
      });
      resolve(out);
    });
    child.stdin.end(hashes.map((h) => `${h}^{commit}`).join("\n") + "\n");
  });
}

async function verifyCommits(
  wanted: Map<string, Set<string>>, // repo top → short/long hashes
  repos: Map<string, RepoInfo>,
): Promise<void> {
  const now = Date.now();
  for (const [top, set] of wanted) {
    const repo = repos.get(top)!;
    const todo = [...set].filter((h) => {
      const c = commitCache.get(`${top}@${h}`);
      if (!c) return true;
      return c.info ? now - c.checkedAt > REMOTES_TTL : now - c.checkedAt > MISS_TTL;
    });
    if (todo.length === 0) continue;
    const found = await gitBatchCheck(top, todo);
    for (const h of todo) {
      const full = found.get(h);
      if (!full) {
        commitCache.set(`${top}@${h}`, { info: null, checkedAt: now });
        continue;
      }
      let subject: string | null = null;
      let author: string | null = null;
      let date: string | null = null;
      let remotes: string[] | null = null;
      try {
        const { stdout } = await execFileAsync("git", [
          "-C", top, "log", "-1", "--format=%h%x1f%an%x1f%aI%x1f%s", full,
        ]);
        const [, an, ad, s] = stdout.replace(/\n$/, "").split("\x1f");
        [author, date, subject] = [an ?? null, ad ?? null, s ?? null];
        const r = await execFileAsync("git", [
          "-C", top, "branch", "-r", "--contains", full, "--format=%(refname:short)",
        ]);
        remotes = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      } catch {
        /* keep partial info */
      }
      commitCache.set(`${top}@${h}`, {
        info: {
          hash: full,
          abbrev: full.slice(0, 7),
          subject,
          author,
          date,
          remotes,
          project: repo.project,
          app: repo.app,
          verified: true,
        },
        checkedAt: now,
      });
    }
  }
}

// ── Model ────────────────────────────────────────────────────────────────────

const modelCache = new Map<string, CommsModel>();
let building: Promise<CommsModel> | null = null;

async function listTranscripts(days: number): Promise<{ abs: string; id: string; mtimeMs: number; size: number }[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const out: { abs: string; id: string; mtimeMs: number; size: number }[] = [];
  let dirs: string[];
  try {
    dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = (await fs.readdir(path.join(PROJECTS_DIR, d))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const abs = path.join(PROJECTS_DIR, d, f);
      try {
        const st = await fs.stat(abs);
        if (st.mtimeMs >= cutoff)
          out.push({ abs, id: f.replace(/\.jsonl$/, ""), mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/**
 * The comms model over transcripts touched in the last `days`. Cached by file
 * signature. With `activity`, every session that ran tools in the window is a
 * node (not only those that messaged) and `model.activity` holds its tool calls.
 */
export async function getCommsModel(
  days = DEFAULT_DAYS,
  opts: { activity?: boolean } = {},
): Promise<CommsModel> {
  // Fractional days allowed (1 h = 1/24); rounded to the minute for caching.
  const d = Math.min(Math.max(1 / 24, Math.round(days * 1440) / 1440), MAX_DAYS);
  // Serialize builds: concurrent pollers share one pass over the files.
  while (building) await building.catch(() => null);
  building = buildModel(d, !!opts.activity);
  try {
    return await building;
  } finally {
    building = null;
  }
}

async function buildModel(days: number, withActivity: boolean): Promise<CommsModel> {
  const [files, registry] = await Promise.all([listTranscripts(days), readRegistry()]);
  const cacheKey = `${days}:${withActivity}`;
  const version = createHash("sha1")
    .update(cacheKey)
    .update(files.map((f) => `${f.abs}:${f.size}`).sort().join("|"))
    .update(registry.sig)
    .digest("hex")
    .slice(0, 16);
  const cached = modelCache.get(cacheKey);
  if (cached && cached.version === version) return cached;

  const states: FileState[] = [];
  for (const f of files) {
    const st = await refreshFile(f.abs, f.id);
    if (st) states.push(st);
  }
  // States of files outside this window are kept: another window may want them.

  const model = await assemble(states, registry.entries, days, version, withActivity);
  modelCache.set(cacheKey, model);
  return model;
}

async function assemble(
  states: FileState[],
  registry: RegistryEntry[],
  days: number,
  version: string,
  withActivity: boolean,
): Promise<CommsModel> {
  const nodes = new Map<string, CommsNode>();
  const bySession = new Map(states.map((s) => [s.sessionId, s]));
  const regBySession = new Map(registry.map((r) => [r.sessionId, r]));
  const socketToSession = new Map<string, string>();
  for (const r of registry) if (r.socket) socketToSession.set(r.socket, r.sessionId);

  // Pair outgoing ↔ incoming by msg_id; that also maps sender sockets to sessions.
  const outByMsg = new Map<string, { st: FileState; out: RawOut }>();
  for (const st of states)
    for (const out of st.outs.values()) if (out.msgId) outByMsg.set(out.msgId, { st, out });
  const inByMsg = new Map<string, { st: FileState; inc: RawIn }>();
  for (const st of states)
    for (const inc of st.ins) {
      if (inc.msgId) inByMsg.set(inc.msgId, { st, inc });
      const pair = inc.msgId ? outByMsg.get(inc.msgId) : undefined;
      if (pair && !socketToSession.has(inc.from)) socketToSession.set(inc.from, pair.st.sessionId);
    }

  // Name history per session: own /renames, what receivers were told, the registry.
  const nameEvents = new Map<string, { name: string; at: string | null }[]>();
  const addName = (sid: string, name: string | null, at: string | null) => {
    if (!name) return;
    const list = nameEvents.get(sid) ?? [];
    list.push({ name, at });
    nameEvents.set(sid, list);
  };
  for (const st of states) for (const r of st.renames) addName(st.sessionId, r.name, r.ts);
  for (const st of states)
    for (const inc of st.ins) {
      const sid = socketToSession.get(inc.from);
      if (sid) addName(sid, inc.fromName, inc.ts);
    }
  for (const r of registry)
    addName(r.sessionId, r.name, r.nameSince ? new Date(r.nameSince).toISOString() : null);
  const nameToSession = new Map<string, string>();
  for (const [sid, list] of nameEvents) {
    for (const e of [...list].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")))
      nameToSession.set(e.name, sid);
  }
  // Live names win over historical ones.
  for (const r of registry) if (r.name) nameToSession.set(r.name, r.sessionId);

  const sessionNode = (sid: string): string => {
    const key = `s:${sid}`;
    if (!nodes.has(key)) {
      const st = bySession.get(sid);
      const reg = regBySession.get(sid);
      const events = (nameEvents.get(sid) ?? []).sort((a, b) =>
        (a.at ?? "").localeCompare(b.at ?? ""),
      );
      const names: { name: string; at: string | null }[] = [];
      for (const e of events)
        if (names.length === 0 || names[names.length - 1].name !== e.name) names.push(e);
      nodes.set(key, {
        key,
        sessionId: sid,
        shortId: sid.slice(0, 8),
        name: reg?.name ?? names[names.length - 1]?.name ?? sid.slice(0, 8),
        names,
        cwd: st?.cwd ?? reg?.cwd ?? null,
        gitBranch: st?.gitBranch ?? null,
        live: !!reg,
        status: reg?.status ?? null,
        tmux: reg?.tmux ?? null,
        sockets: [],
        role: "peer",
        sent: 0,
        received: 0,
        lastActivity: st?.lastTs ?? null,
      });
    }
    return key;
  };
  const externalNode = (id: string, name: string | null): string => {
    const key = `x:${id}`;
    if (!nodes.has(key)) {
      const pid = id.match(/\/(\d+)\.sock$/)?.[1];
      nodes.set(key, {
        key,
        sessionId: null,
        shortId: pid ? `pid ${pid}` : "?",
        name: name ?? (pid ? `pid ${pid}` : id),
        names: name ? [{ name, at: null }] : [],
        cwd: null,
        gitBranch: null,
        live: false,
        status: null,
        tmux: null,
        sockets: id.startsWith("uds:") ? [id] : [],
        role: "peer",
        sent: 0,
        received: 0,
        lastActivity: null,
      });
    }
    return nodes.get(key)!.key;
  };
  const resolveTarget = (to: string, name: string | null): string => {
    const sid = socketToSession.get(to) ?? nameToSession.get(to) ?? nameToSession.get(to.replace(/\s*\[[0-9a-f]+\]$/, ""));
    return sid ? sessionNode(sid) : externalNode(to, name ?? (to.startsWith("uds:") ? null : to));
  };

  const clip = (text: string) => {
    const red = redact(text);
    return red.length > MAX_BODY
      ? { body: `${red.slice(0, MAX_BODY)}\n… (truncated)`, truncated: true }
      : { body: red, truncated: false };
  };

  const messages: CommsMessage[] = [];
  const seenIncoming = new Set<RawIn>();
  for (const st of states) {
    const from = sessionNode(st.sessionId);
    for (const out of st.outs.values()) {
      const paired = out.msgId ? inByMsg.get(out.msgId) : undefined;
      if (paired) seenIncoming.add(paired.inc);
      // Results without a msg_id are in-process subagent sends, not sessions.
      if (out.result && out.result !== "failed" && !out.msgId) continue;
      const to = paired ? sessionNode(paired.st.sessionId) : resolveTarget(out.to, null);
      const { body, truncated } = clip(out.body);
      messages.push({
        id: out.msgId ?? `${st.sessionId}:${out.toolUseId}`,
        from,
        to,
        sentAt: out.ts,
        receivedAt: paired?.inc.ts ?? null,
        state: paired ? "received" : (out.result ?? "sending"),
        summary: out.summary ? redact(out.summary) : null,
        body,
        truncated,
        tags: parseTags(out.body),
        guess: null,
      });
    }
  }
  for (const st of states) {
    const to = sessionNode(st.sessionId);
    for (const inc of st.ins) {
      if (seenIncoming.has(inc)) continue;
      const sid = socketToSession.get(inc.from);
      const from = sid ? sessionNode(sid) : externalNode(inc.from, inc.fromName);
      const { body, truncated } = clip(inc.body);
      messages.push({
        id: inc.msgId ?? `${st.sessionId}:in:${inc.ts}`,
        from,
        to,
        sentAt: null,
        receivedAt: inc.ts,
        state: "received",
        summary: null,
        body,
        truncated,
        tags: parseTags(inc.body),
        guess: null,
      });
    }
  }
  messages.sort((a, b) =>
    (a.sentAt ?? a.receivedAt ?? "").localeCompare(b.sentAt ?? b.receivedAt ?? ""),
  );

  for (const m of messages) {
    nodes.get(m.from)!.sent++;
    nodes.get(m.to)!.received++;
  }
  for (const r of registry) {
    const n = nodes.get(`s:${r.sessionId}`);
    if (n && r.socket) n.sockets.push(r.socket);
  }
  for (const [sock, sid] of socketToSession) {
    const n = nodes.get(`s:${sid}`);
    if (n && !n.sockets.includes(sock)) n.sockets.push(sock);
  }

  // State (tasks, claims) comes from everything loaded, so a task dispatched
  // before the window still has the right state; only the window's messages
  // and tool calls are returned.
  const { tasks, files, mentions } = deriveState(messages);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const windowed = messages.filter((m) => (m.sentAt ?? m.receivedAt ?? "") >= cutoff);
  let activity: CommsModel["activity"];
  if (withActivity) {
    activity = {};
    for (const st of states) {
      const recent = st.activity.filter((a) => a.t >= cutoff);
      if (recent.length === 0) continue;
      activity[sessionNode(st.sessionId)] = recent.slice(-MAX_ACTIVITY);
    }
  }
  const nodeList = [...nodes.values()].filter(
    (n) => n.sent + n.received > 0 || (activity && activity[n.key]),
  );
  assignRoles(nodeList, tasks);
  const commits = await resolveCommits(mentions, nodes);

  return {
    version,
    generatedAt: new Date().toISOString(),
    days,
    nodes: nodeList,
    messages: windowed,
    tasks,
    files,
    commits,
    ...(activity ? { activity } : {}),
  };
}

async function resolveCommits(
  mentions: CommitMention[],
  nodes: Map<string, CommsNode>,
): Promise<CommitInfo[]> {
  const repos = new Map<string, RepoInfo>();
  const repoOfMention = new Map<CommitMention, RepoInfo>();
  const wanted = new Map<string, Set<string>>();
  for (const m of mentions) {
    const cwd = nodes.get(m.node)?.cwd;
    if (!cwd) continue;
    const repo = await repoFor(cwd);
    if (!repo) continue;
    repos.set(repo.top, repo);
    repoOfMention.set(m, repo);
    if (!wanted.has(repo.top)) wanted.set(repo.top, new Set());
    wanted.get(repo.top)!.add(m.hash);
  }
  await verifyCommits(wanted, repos);

  const out = new Map<string, CommitInfo>();
  for (const m of mentions) {
    const repo = repoOfMention.get(m);
    const cached = repo ? commitCache.get(`${repo.top}@${m.hash}`)?.info : null;
    // Untagged hex words only count when git knows them; tagged ones always show.
    if (!cached && m.kind === "mention") continue;
    const key = cached ? `${repo!.top}@${cached.hash}` : `?@${m.hash}`;
    let c = out.get(key);
    if (!c) {
      c = cached
        ? { ...cached, pushedTag: false, mentions: [] }
        : {
            hash: m.hash,
            abbrev: m.hash.slice(0, 7),
            subject: null,
            author: null,
            date: null,
            remotes: null,
            project: repo?.project ?? null,
            app: repo?.app ?? null,
            verified: false,
            pushedTag: false,
            mentions: [],
          };
      out.set(key, c);
    }
    c.mentions.push(m);
    if (m.kind === "pushed") c.pushedTag = true;
  }
  return [...out.values()].sort((a, b) =>
    (b.mentions[b.mentions.length - 1]?.at ?? "").localeCompare(
      a.mentions[a.mentions.length - 1]?.at ?? "",
    ),
  );
}
