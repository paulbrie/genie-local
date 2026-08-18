"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, Minus, Workflow, X } from "lucide-react";
import { useSubject } from "subjecto/react";

import { RunConsole, LIFECYCLE_BADGE } from "@/components/run-console";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import type { RunLifecycle, RunSummary } from "@/lib/agent-run-types";
import { listRunsAction } from "@/app/actions";
import {
  activeRuns,
  closeRun,
  hydrateRunDock,
  minimizeRun,
  reconcileRuns,
  restoreRun,
  runDock,
  setActiveRuns,
} from "@/store/runs";

const POLL_MS = 3000;

/** Small lifecycle dot: pulsing emerald while active, red/grey/amber otherwise. */
function RunDot({ state, running }: { state: RunLifecycle; running: boolean }) {
  const color =
    state === "failed"
      ? "bg-red-500"
      : state === "done"
        ? "bg-emerald-500"
        : state === "stopped"
          ? "bg-muted-foreground/40"
          : running || state === "running"
            ? "bg-emerald-500"
            : "bg-amber-500";
  const pulse = running || state === "running" || state === "starting";
  return <StatusDot color={color} pulse={pulse} />;
}

/**
 * Renders every open agent/pipeline run as a floating, movable + resizable
 * window, plus a bottom-left bar of the minimized ones. Mounted once in the
 * root layout so windows persist across route changes and page reloads. The
 * runs themselves are detached server processes with on-disk progress/logs, so
 * a restored window simply re-attaches by runId. Membership lives in the
 * `@/store/runs` subject; this component paints it and keeps the shared run
 * list fresh.
 */
export function RunDock() {
  const pathname = usePathname();
  const [{ open, minimized }] = useSubject(runDock);
  const [runs] = useSubject(activeRuns);
  const zTop = useRef(50);
  const bringToFront = useCallback(() => ++zTop.current, []);

  const byId = new Map(runs.map((r) => [r.runId, r]));

  useEffect(() => {
    hydrateRunDock();
  }, []);

  // Poll the run list: powers the history, the card indicators (via the shared
  // `activeRuns` subject), the window titles, and drops windows whose run files
  // vanished (deleted from history).
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const list = await listRunsAction();
        if (!active) return;
        setActiveRuns(list);
        reconcileRuns(list.map((r) => r.runId));
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (pathname === "/login") return null;

  return (
    <>
      {open.map((runId, i) => (
        <RunWindow
          key={runId}
          runId={runId}
          summary={byId.get(runId)}
          index={i}
          minimized={minimized.includes(runId)}
          bringToFront={bringToFront}
          onMinimize={() => minimizeRun(runId)}
          onClose={() => closeRun(runId)}
        />
      ))}

      {minimized.length > 0 && (
        <div className="fixed bottom-3 left-3 z-[60] flex max-w-[60vw] flex-wrap items-center gap-1.5 rounded-full border bg-background/95 px-2 py-1.5 shadow-2xl ring-1 ring-foreground/10 backdrop-blur">
          <span className="px-1 text-xs text-muted-foreground">Runs</span>
          {minimized.map((runId) => {
            const r = byId.get(runId);
            return (
              <span
                key={runId}
                className="flex items-center gap-1 rounded-full border bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs"
              >
                <button
                  type="button"
                  onClick={() => restoreRun(runId)}
                  title={`Restore ${r?.name ?? runId}`}
                  className="flex items-center gap-1.5 font-medium hover:underline"
                >
                  <RunDot
                    state={r?.state ?? "starting"}
                    running={Boolean(r?.running)}
                  />
                  <span className="max-w-[10rem] truncate">
                    {r?.name ?? runId}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => closeRun(runId)}
                  aria-label={`Close ${r?.name ?? runId}`}
                  title="Close window (run keeps going)"
                  className="rounded-full p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

function RunWindow({
  runId,
  summary,
  index,
  minimized,
  bringToFront,
  onMinimize,
  onClose,
}: {
  runId: string;
  summary: RunSummary | undefined;
  index: number;
  minimized: boolean;
  bringToFront: () => number;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState(() => ({
    x: 160 + index * 32,
    y: 80 + index * 32,
  }));
  const [z, setZ] = useState(() => bringToFront());
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  function onHeaderPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    setZ(bringToFront());
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!drag.current) return;
      setPos({
        x: Math.max(0, ev.clientX - drag.current.dx),
        y: Math.max(0, ev.clientY - drag.current.dy),
      });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const state = summary?.state ?? "starting";
  const badge = LIFECYCLE_BADGE[state];
  const Icon = summary?.kind === "pipeline" ? Workflow : Bot;

  return (
    <div
      role="dialog"
      aria-label={`Run ${summary?.name ?? runId}`}
      onPointerDown={() => setZ(bringToFront())}
      style={{ left: pos.x, top: pos.y, zIndex: z }}
      // Kept mounted while minimized (hidden) so its console/scroll survive a
      // minimize → restore round-trip.
      className={`fixed flex h-[28rem] max-h-[90vh] min-h-[14rem] w-[40rem] max-w-[92vw] min-w-[22rem] resize flex-col overflow-hidden rounded-lg border bg-background shadow-2xl ring-1 ring-foreground/10 ${
        minimized ? "hidden" : ""
      }`}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex cursor-move items-center gap-1.5 border-b bg-muted/60 px-2.5 py-1.5 select-none"
      >
        <Icon className="size-4 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {summary?.name ?? runId}
        </span>
        <Badge className={`font-normal ${badge.className}`}>{badge.label}</Badge>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimize window"
          title="Minimize to the runs bar"
          className="rounded p-1 opacity-70 hover:bg-muted hover:opacity-100"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close window"
          title="Close window (run keeps going)"
          className="rounded p-1 opacity-70 hover:bg-muted hover:opacity-100"
        >
          <X className="size-4" />
        </button>
      </div>

      <RunConsole runId={runId} />
    </div>
  );
}
