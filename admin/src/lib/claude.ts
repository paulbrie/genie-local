import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Root of the Claude Code data directory (`~/.claude`). The admin service runs
 * as `genie`, so this resolves to `/home/genie/.claude`. Override with CLAUDE_HOME.
 *
 * Layout we read:
 *   projects/<encoded-cwd>/<session-uuid>.jsonl  — one JSONL transcript per session
 *   projects/<encoded-cwd>/memory/*.md           — per-project agent memories
 * plus any `*.log` / `*.jsonl` under the tree, surfaced as raw "logs".
 */
export const CLAUDE_HOME =
  process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");

const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

// Session files larger than this are sampled (head+tail) rather than fully
// parsed, so listing never stalls on a multi-MB transcript.
const FULL_PARSE_MAX = 3 * 1024 * 1024;
const SAMPLE_BYTES = 96 * 1024;

// Raw-log tail sizing (mirrors src/lib/logs.ts).
export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const EXCLUDE_DIRS = new Set(["node_modules", ".git", ".cache", ".next"]);
const LOG_EXTENSIONS = new Set([".log", ".out", ".err", ".jsonl", ".txt"]);
const MAX_DEPTH = 5;

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionSummary = {
  /** Session UUID (the JSONL filename without extension). */
  id: string;
  /** Encoded project dir name under ~/.claude/projects. */
  project: string;
  /** Working directory the session ran in (from the transcript, when present). */
  cwd: string | null;
  gitBranch: string | null;
  /** Short human label: the session's own summary, else its first user message. */
  title: string;
  size: number;
  mtimeMs: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Total transcript lines; null when the file was too large to fully count. */
  messageCount: number | null;
};

export type TranscriptBlock = {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  name?: string;
};

export type TranscriptMessage = {
  uuid: string | null;
  role: "user" | "assistant" | "system";
  timestamp: string | null;
  blocks: TranscriptBlock[];
};

export type MemoryFile = {
  /** Path relative to CLAUDE_HOME (the id used to read it back). */
  path: string;
  project: string;
  title: string;
  description: string | null;
  type: string | null;
  size: number;
  mtimeMs: number;
};

export type LogFile = { path: string; size: number; mtimeMs: number };

export type LogTail = {
  path: string;
  size: number;
  mtimeMs: number;
  returnedBytes: number;
  truncated: boolean;
  content: string;
};

// ── Path safety ──────────────────────────────────────────────────────────────

/** Resolve `rel` under `base`, rejecting traversal / absolute escapes. */
function resolveWithin(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  const check = path.relative(base, resolved);
  if (check === "" || check.startsWith("..") || path.isAbsolute(check)) {
    throw new Error("Path is outside the Claude data directory");
  }
  return resolved;
}

/** A single path segment (project dir name / session id): no separators. */
function assertSegment(seg: string): void {
  if (!seg || seg.includes("/") || seg.includes("\\") || seg.includes("..")) {
    throw new Error("Invalid identifier");
  }
}

// ── Low-level reads ──────────────────────────────────────────────────────────

/** Read a byte window `[start, start+len)` of a file as UTF-8. */
async function readSlice(abs: string, start: number, len: number): Promise<string> {
  const handle = await fs.open(abs, "r");
  try {
    const size = Math.max(0, len);
    const buf = Buffer.alloc(size);
    if (size > 0) await handle.read(buf, 0, size, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Parse the JSON on each non-empty line, dropping unparseable ones. */
function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") out.push(obj as Record<string, unknown>);
    } catch {
      // partial line (from a mid-file slice) or corruption — skip
    }
  }
  return out;
}

// ── Transcript extraction ────────────────────────────────────────────────────

/** First readable text out of a message's `content` (string or block array). */
function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
      }
    }
  }
  return "";
}

/** Turn a message's `content` into simplified, renderable blocks. */
function toBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text)
          blocks.push({ kind: "text", text: b.text });
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking)
          blocks.push({ kind: "thinking", text: b.thinking });
        break;
      case "tool_use":
        blocks.push({
          kind: "tool_use",
          name: typeof b.name === "string" ? b.name : "tool",
          text:
            b.input != null ? safeJson(b.input) : "",
        });
        break;
      case "tool_result": {
        const c = b.content;
        blocks.push({
          kind: "tool_result",
          text: typeof c === "string" ? c : firstText(c) || safeJson(c),
        });
        break;
      }
    }
  }
  return blocks;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Derive a session summary from (a sample of) its transcript lines. */
function deriveSummary(
  lines: Record<string, unknown>[],
  base: { id: string; project: string; size: number; mtimeMs: number },
  messageCount: number | null,
): SessionSummary {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let summaryText = "";
  let firstUser = "";
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const obj of lines) {
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !gitBranch) gitBranch = obj.gitBranch;
    if (obj.type === "summary" && typeof obj.summary === "string" && !summaryText)
      summaryText = obj.summary;
    if (obj.type === "user" && !firstUser) {
      const msg = obj.message as Record<string, unknown> | undefined;
      const text = firstText(msg?.content).trim();
      // Skip tool-result-only / command-noise user turns for the title.
      if (text && !text.startsWith("<")) firstUser = text;
    }
    if (typeof obj.timestamp === "string") {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
  }

  const title = (summaryText || firstUser || "(no messages)").trim();
  return {
    ...base,
    cwd,
    gitBranch,
    title: title.length > 200 ? `${title.slice(0, 200)}…` : title,
    firstTimestamp,
    lastTimestamp,
    messageCount,
  };
}

async function summarizeSession(
  abs: string,
  id: string,
  project: string,
): Promise<SessionSummary | null> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return null;
  }
  const base = { id, project, size: stat.size, mtimeMs: stat.mtimeMs };

  try {
    if (stat.size <= FULL_PARSE_MAX) {
      const text = await fs.readFile(abs, "utf8");
      const lines = parseLines(text);
      return deriveSummary(lines, base, lines.length);
    }
    // Too big to fully parse: sample head + tail for metadata.
    const head = await readSlice(abs, 0, SAMPLE_BYTES);
    const tail = await readSlice(abs, Math.max(0, stat.size - SAMPLE_BYTES), SAMPLE_BYTES);
    const lines = parseLines(`${head}\n${tail}`);
    return deriveSummary(lines, base, null);
  } catch {
    return deriveSummary([], base, null);
  }
}

/** All sessions across every project, newest activity first. */
export async function listSessions(): Promise<SessionSummary[]> {
  let projects: string[];
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // no ~/.claude/projects yet
  }

  const out: SessionSummary[] = [];
  for (const project of projects) {
    const dir = path.join(PROJECTS_DIR, project);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const summaries = await Promise.all(
      files.map((f) =>
        summarizeSession(path.join(dir, f), f.replace(/\.jsonl$/, ""), project),
      ),
    );
    for (const s of summaries) if (s) out.push(s);
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Full (or tail-capped) transcript of one session, as renderable messages. */
export async function getTranscript(
  project: string,
  id: string,
  maxMessages = 4000,
): Promise<TranscriptMessage[] | null> {
  assertSegment(project);
  assertSegment(id);
  const abs = resolveWithin(PROJECTS_DIR, path.join(project, `${id}.jsonl`));

  let text: string;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    if (stat.size <= FULL_PARSE_MAX) {
      text = await fs.readFile(abs, "utf8");
    } else {
      // Keep the tail — most recent turns — for oversized transcripts.
      text = await readSlice(abs, stat.size - FULL_PARSE_MAX, FULL_PARSE_MAX);
    }
  } catch {
    return null;
  }

  const messages: TranscriptMessage[] = [];
  for (const obj of parseLines(text)) {
    const type = obj.type;
    if (type !== "user" && type !== "assistant" && type !== "system") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    const content = msg?.content ?? (typeof obj.content === "string" ? obj.content : undefined);
    const blocks = toBlocks(content);
    if (blocks.length === 0) continue;
    messages.push({
      uuid: typeof obj.uuid === "string" ? obj.uuid : null,
      role: type,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
      blocks,
    });
  }

  return messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
}

// ── Memories ─────────────────────────────────────────────────────────────────

/** Pull `name` / `description` / `metadata.type` out of a memory's frontmatter. */
function parseFrontmatter(text: string): {
  title: string | null;
  description: string | null;
  type: string | null;
} {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { title: null, description: null, type: null };
  const body = m[1];
  const get = (key: string) => {
    // Tolerate indentation: `type` lives nested under `metadata:` in our format.
    const line = body.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return { title: get("name"), description: get("description"), type: get("type") };
}

/** Every memory markdown file found under any project's `memory/` dir. */
export async function listMemories(): Promise<MemoryFile[]> {
  let projects: string[];
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const out: MemoryFile[] = [];
  for (const project of projects) {
    const memDir = path.join(PROJECTS_DIR, project, "memory");
    let files: string[];
    try {
      files = (await fs.readdir(memDir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // this project has no memories
    }
    for (const f of files) {
      const abs = path.join(memDir, f);
      try {
        const [stat, text] = await Promise.all([
          fs.stat(abs),
          fs.readFile(abs, "utf8"),
        ]);
        const fm = parseFrontmatter(text);
        out.push({
          path: path.relative(CLAUDE_HOME, abs),
          project,
          title: fm.title ?? f.replace(/\.md$/, ""),
          description: fm.description,
          type: fm.type,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // vanished / unreadable — skip
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Raw markdown of a single memory file (validated within CLAUDE_HOME). */
export async function readMemory(rel: string): Promise<string | null> {
  const abs = resolveWithin(CLAUDE_HOME, rel);
  if (path.extname(abs).toLowerCase() !== ".md") throw new Error("Not a memory file");
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

// ── Raw logs (any log-like file under ~/.claude) ─────────────────────────────

function isLogName(name: string): boolean {
  return LOG_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Recursively collect log-like files under CLAUDE_HOME, newest first. */
export async function listLogs(): Promise<LogFile[]> {
  const root = path.resolve(CLAUDE_HOME);
  const out: LogFile[] = [];

  async function walk(cur: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || EXCLUDE_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
      } else if (entry.isFile() && isLogName(entry.name)) {
        try {
          const st = await fs.stat(abs);
          out.push({ path: path.relative(root, abs), size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished — skip
        }
      }
    }
  }

  await walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Read the last `maxBytes` of a log file under CLAUDE_HOME. */
export async function readLogTail(
  rel: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): Promise<LogTail | null> {
  const abs = resolveWithin(CLAUDE_HOME, rel);
  if (!isLogName(abs)) throw new Error("Not a log file");
  const window = Math.min(Math.max(1, maxBytes), MAX_TAIL_BYTES);

  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    const readSize = Math.min(st.size, window);
    const start = st.size - readSize;
    const buf = Buffer.alloc(readSize);
    if (readSize > 0) await handle.read(buf, 0, readSize, start);
    let content = buf.toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const nl = content.indexOf("\n");
      if (nl !== -1) content = content.slice(nl + 1);
    }
    return {
      path: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      returnedBytes: readSize,
      truncated,
      content,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
