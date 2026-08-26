"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import { formatBytes, formatRelativeTime } from "@/lib/format";

type SessionSummary = {
  id: string;
  project: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  size: number;
  mtimeMs: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  messageCount: number | null;
};

type TranscriptBlock = {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  name?: string;
};
type TranscriptMessage = {
  uuid: string | null;
  role: "user" | "assistant" | "system";
  timestamp: string | null;
  blocks: TranscriptBlock[];
};

export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/claude/sessions`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const json: { sessions: SessionSummary[] } = await res.json();
      setSessions(json.sessions);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, []);

  const loadTranscript = useCallback(async (s: SessionSummary) => {
    setLoading(true);
    setMessages(null);
    setTranscriptError(null);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/claude/sessions/transcript?project=${encodeURIComponent(
          s.project,
        )}&id=${encodeURIComponent(s.id)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? String(res.status));
      }
      const json: { messages: TranscriptMessage[] } = await res.json();
      setMessages(json.messages);
    } catch (e) {
      setTranscriptError(e instanceof Error ? e.message : "failed to read");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  function select(s: SessionSummary) {
    setSelected(s);
    loadTranscript(s);
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q) ||
          (s.cwd ?? "").toLowerCase().includes(q),
      )
    : sessions;

  return (
    <div className="flex h-[calc(100vh-14rem)] gap-4">
      {/* Session list */}
      <aside className="flex w-96 shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions…"
            className="h-8"
          />
          <Button size="sm" variant="outline" onClick={loadList}>
            Refresh
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {listError ? (
            <p className="p-3 text-sm text-destructive">
              Failed to list sessions.
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {sessions.length === 0 ? "No sessions found." : "No matches."}
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((s) => (
                <li key={`${s.project}/${s.id}`}>
                  <button
                    type="button"
                    onClick={() => select(s)}
                    className={`flex w-full flex-col items-start gap-1 px-3 py-2 text-left hover:bg-muted/60 ${
                      selected?.id === s.id && selected?.project === s.project
                        ? "bg-muted"
                        : ""
                    }`}
                  >
                    <span className="line-clamp-2 w-full text-sm font-medium">
                      {s.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="truncate font-mono">
                        {s.cwd ?? s.project}
                      </span>
                      {s.gitBranch && (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          {s.gitBranch}
                        </Badge>
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {s.messageCount != null ? `${s.messageCount} msgs · ` : ""}
                      {formatBytes(s.size)} ·{" "}
                      {formatRelativeTime(new Date(s.mtimeMs))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {shown.length} of {sessions.length} session
          {sessions.length === 1 ? "" : "s"}
        </p>
      </aside>

      {/* Transcript */}
      <section className="flex min-w-0 flex-1 flex-col gap-2">
        {!selected ? (
          <div className="grid flex-1 place-items-center rounded-md border text-sm text-muted-foreground">
            Pick a session on the left to read its transcript.
          </div>
        ) : (
          <>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{selected.title}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {selected.cwd ?? selected.project} · {selected.id}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto rounded-md border bg-muted/20 p-3">
              {transcriptError ? (
                <p className="text-sm text-destructive">
                  Error: {transcriptError}
                </p>
              ) : loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : messages && messages.length > 0 ? (
                messages.map((m, i) => <MessageBubble key={m.uuid ?? i} m={m} />)
              ) : (
                <p className="text-sm text-muted-foreground">
                  (no renderable messages)
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const ROLE_LABEL: Record<TranscriptMessage["role"], string> = {
  user: "User",
  assistant: "Claude",
  system: "System",
};

function MessageBubble({ m }: { m: TranscriptMessage }) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <Badge
          variant={m.role === "assistant" ? "default" : "secondary"}
          className="h-4 px-1.5 text-[10px]"
        >
          {ROLE_LABEL[m.role]}
        </Badge>
        {m.timestamp && (
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(new Date(m.timestamp))}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {m.blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
    </div>
  );
}

function Block({ b }: { b: TranscriptBlock }) {
  if (b.kind === "text") {
    return (
      <p className="text-sm whitespace-pre-wrap break-words">{b.text}</p>
    );
  }
  if (b.kind === "thinking") {
    return (
      <details className="rounded border border-dashed bg-muted/40 p-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Thinking
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
          {b.text}
        </p>
      </details>
    );
  }
  // tool_use / tool_result
  const label = b.kind === "tool_use" ? `⚙ ${b.name ?? "tool"}` : "↩ result";
  return (
    <details className="rounded border bg-muted/40 p-2 text-xs">
      <summary className="cursor-pointer font-mono text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-words">
        {b.text}
      </pre>
    </details>
  );
}
