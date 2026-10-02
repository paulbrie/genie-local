"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Code2,
  Eye,
  FileText,
  Loader2,
  RotateCw,
  Square,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  rerunRunAction,
  runProgressByIdAction,
  stopRunByIdAction,
} from "@/app/actions";
import { AnsiText, stripAnsi } from "@/components/ansi-text";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  RunLifecycle,
  RunProgress,
  RunStep,
  RunUsage,
  StepState,
} from "@/lib/agent-run-types";
import { BASE_PATH } from "@/lib/config";
import type { RunStatus } from "@/lib/runner";
import { openRun } from "@/store/runs";

/** Compact one-line usage summary, e.g. "3 turns · $0.0421 · 12.3k tok · 8.1s". */
export function formatUsage(u: RunUsage | null | undefined): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.turns != null) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
  if (u.costUsd != null) parts.push(`$${u.costUsd.toFixed(4)}`);
  const tok = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (tok > 0)
    parts.push(tok >= 1000 ? `${(tok / 1000).toFixed(1)}k tok` : `${tok} tok`);
  if (u.durationMs != null) parts.push(`${(u.durationMs / 1000).toFixed(1)}s`);
  return parts.length ? parts.join(" · ") : null;
}

const POLL_MS = 1500;
const TAIL_BYTES = 128 * 1024;

/** How the log pane renders its content: raw terminal output or rendered
 *  Markdown. Persisted so the choice sticks across runs and reloads. */
type LogView = "raw" | "rendered";
const LOG_VIEW_KEY = "admin-run-log-view";
function loadLogView(): LogView {
  try {
    return localStorage.getItem(LOG_VIEW_KEY) === "rendered" ? "rendered" : "raw";
  } catch {
    return "raw";
  }
}
function saveLogView(v: LogView) {
  try {
    localStorage.setItem(LOG_VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}

export const LIFECYCLE_BADGE: Record<
  RunLifecycle,
  { label: string; className: string }
> = {
  queued: { label: "queued", className: "bg-sky-500/15 text-sky-600" },
  starting: { label: "starting", className: "bg-amber-500/15 text-amber-600" },
  running: { label: "running", className: "bg-emerald-500/15 text-emerald-600" },
  done: { label: "done", className: "bg-emerald-500/15 text-emerald-600" },
  failed: { label: "failed", className: "bg-red-500/15 text-red-600" },
  stopped: { label: "stopped", className: "bg-muted text-muted-foreground" },
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "running")
    return <Loader2 className="size-4 shrink-0 animate-spin text-emerald-500" />;
  if (state === "done")
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
  if (state === "failed")
    return <XCircle className="size-4 shrink-0 text-red-500" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground/40" />;
}

function isTerminal(state: RunLifecycle): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

/**
 * Live run console for ONE run (by runId): a step tracker (which agent is
 * currently working) plus the tailing run log, refreshed on a short poll while
 * the run is active. Reads everything (name, kind, steps, log path) from the
 * run's progress file, so it re-attaches to any run — including one started
 * before a page reload. Rendered inside a floating window by <RunDock>.
 */
export function RunConsole({
  runId,
  onProgress,
}: {
  runId: string;
  onProgress?: (progress: RunProgress | null, status: RunStatus) => void;
}) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [log, setLog] = useState("");
  const [stopping, setStopping] = useState(false);
  const [logView, setLogView] = useState<LogView>("raw");
  const logRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  // Restore the persisted view after mount (localStorage is client-only).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLogView(loadLogView());
  }, []);

  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const logFile = progress?.logFile ?? null;
  const fetchLog = useCallback(async () => {
    if (!logFile) return;
    try {
      const res = await fetch(
        `${BASE_PATH}/api/logs/tail?file=${encodeURIComponent(logFile)}&bytes=${TAIL_BYTES}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json: { content?: string } = await res.json();
      setLog(json.content ?? "");
    } catch {
      /* keep last */
    }
  }, [logFile]);

  // Poll progress + log until terminal, then one final refresh.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { status: st, progress: p } = await runProgressByIdAction(runId);
        if (!active) return;
        setStatus(st);
        setProgress(p);
        onProgressRef.current?.(p, st);
        await fetchLog();
        if (!active) return;
        const terminal = p ? isTerminal(p.state) && !st.running : !st.running;
        if (!terminal) timer = setTimeout(tick, POLL_MS);
      } catch {
        if (active) timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, fetchLog]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function stop() {
    setStopping(true);
    try {
      const st = await stopRunByIdAction(runId);
      setStatus(st);
      const { progress: p } = await runProgressByIdAction(runId);
      setProgress(p);
      onProgressRef.current?.(p, st);
      await fetchLog();
    } finally {
      setStopping(false);
    }
  }

  const [rerunning, setRerunning] = useState(false);
  async function rerun() {
    setRerunning(true);
    try {
      const newId = await rerunRunAction(runId);
      openRun(newId);
      toast.success("Re-running with the same inputs");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRerunning(false);
    }
  }

  const state = progress?.state ?? "starting";
  const steps: RunStep[] = progress?.steps ?? [];
  const badge = LIFECYCLE_BADGE[state];
  const running =
    Boolean(status?.running) || state === "starting" || state === "queued";
  const doneCount = steps.filter((s) => s.state === "done").length;
  const usageLine = formatUsage(progress?.usage);
  const artifacts = progress?.artifacts ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Badge className={`font-normal ${badge.className}`}>{badge.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {progress?.kind === "pipeline"
            ? `${doneCount}/${steps.length} steps`
            : "agent"}
        </span>
        {usageLine && (
          <span
            className="truncate text-xs text-muted-foreground tabular-nums"
            title="tokens / cost / duration reported by the CLI"
          >
            · {usageLine}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1.5 px-2 text-xs"
              disabled={stopping}
              onClick={stop}
            >
              <Square className="size-3" />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1.5 px-2 text-xs"
              disabled={rerunning}
              onClick={rerun}
              title="Run again with the same inputs"
            >
              <RotateCw className="size-3" />
              {rerunning ? "…" : "Re-run"}
            </Button>
          )}
          {logFile && (
            <a
              href={`${BASE_PATH}/logs?file=${encodeURIComponent(logFile)}&filter=${encodeURIComponent(runId)}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              open in Logs
            </a>
          )}
        </div>
      </div>

      {/* Step tracker */}
      <ol className="max-h-40 shrink-0 space-y-0.5 overflow-auto px-3 py-2">
        {steps.map((s) => (
          <li
            key={s.index}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${
              s.state === "running" ? "bg-emerald-500/5" : ""
            }`}
          >
            <StepIcon state={s.state} />
            <span className="text-xs text-muted-foreground tabular-nums">
              {s.index + 1}
            </span>
            <span className="font-mono">{s.label}</span>
            {s.state === "running" && (
              <span className="text-xs text-emerald-600">working…</span>
            )}
            {formatUsage(s.usage) && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {formatUsage(s.usage)}
              </span>
            )}
          </li>
        ))}
        {steps.length === 0 && (
          <li className="px-2 py-1 text-sm text-muted-foreground">Starting…</li>
        )}
      </ol>

      {progress?.error && (
        <p className="mx-3 mb-2 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-600">
          {progress.error}
        </p>
      )}

      {artifacts.length > 0 && (
        <div className="mx-3 mb-2 space-y-1 rounded-md border bg-muted/30 px-3 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Files written ({artifacts.length})
          </span>
          <ul className="space-y-0.5">
            {artifacts.map((f) => (
              <li
                key={f}
                className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
              >
                <FileText className="size-3 shrink-0" />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Live log */}
      <div className="flex min-h-0 flex-1 flex-col border-t">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
          <span className="text-xs font-medium text-muted-foreground">Log</span>
          <div className="ml-auto flex overflow-hidden rounded-md border">
            {(
              [
                ["raw", "Raw", Code2],
                ["rendered", "Markdown", Eye],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setLogView(value);
                  saveLogView(value);
                }}
                title={
                  value === "raw"
                    ? "Raw terminal output (ANSI colours)"
                    : "Render the log as Markdown"
                }
                className={`flex items-center gap-1 px-2 py-0.5 text-xs transition-colors ${
                  logView === value
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
          </div>
        </div>
        {logView === "rendered" ? (
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className="min-h-0 flex-1 overflow-auto bg-background px-4 py-2"
          >
            {log ? (
              <Markdown source={stripAnsi(log)} />
            ) : (
              <span className="text-sm text-muted-foreground">
                Waiting for output…
              </span>
            )}
          </div>
        ) : (
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className="min-h-0 flex-1 overflow-auto bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200"
          >
            {log ? (
              <pre className="whitespace-pre-wrap break-words">
                <AnsiText text={log} />
              </pre>
            ) : (
              <span className="text-zinc-500">Waiting for output…</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
