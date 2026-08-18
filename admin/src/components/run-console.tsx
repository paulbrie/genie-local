"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Loader2, Square, XCircle } from "lucide-react";

import { runProgressByIdAction, stopRunByIdAction } from "@/app/actions";
import { AnsiText } from "@/components/ansi-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  RunLifecycle,
  RunProgress,
  RunStep,
  StepState,
} from "@/lib/agent-run-types";
import { BASE_PATH } from "@/lib/config";
import type { RunStatus } from "@/lib/runner";

const POLL_MS = 1500;
const TAIL_BYTES = 128 * 1024;

export const LIFECYCLE_BADGE: Record<
  RunLifecycle,
  { label: string; className: string }
> = {
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
  const logRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

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

  const state = progress?.state ?? "starting";
  const steps: RunStep[] = progress?.steps ?? [];
  const badge = LIFECYCLE_BADGE[state];
  const running = Boolean(status?.running) || state === "starting";
  const doneCount = steps.filter((s) => s.state === "done").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Badge className={`font-normal ${badge.className}`}>{badge.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {progress?.kind === "pipeline"
            ? `${doneCount}/${steps.length} steps`
            : "agent"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {running && (
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

      {/* Live log */}
      <div className="flex min-h-0 flex-1 flex-col border-t">
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
      </div>
    </div>
  );
}
