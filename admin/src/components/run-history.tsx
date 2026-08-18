"use client";

import { Bot, ExternalLink, Trash2, Workflow } from "lucide-react";
import { useSubject } from "subjecto/react";

import { deleteRunAction } from "@/app/actions";
import { LIFECYCLE_BADGE } from "@/components/run-console";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import { activeRuns, closeRun, openRun } from "@/store/runs";

/** Relative "3m ago" style time; falls back to a locale string for old runs. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

/**
 * The agent-run history: every run (active + finished), newest first, read from
 * the shared `activeRuns` subject that <RunDock> keeps fresh. Each row opens the
 * run in the dock (re-attaching to its live/finished log) or deletes it.
 */
export function RunHistory() {
  const [runs] = useSubject(activeRuns);

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No runs yet. Start one from an agent or pipeline above.
      </div>
    );
  }

  return (
    <div className="divide-y rounded-lg border">
      {runs.map((r) => {
        const badge = LIFECYCLE_BADGE[r.state];
        const Icon = r.kind === "pipeline" ? Workflow : Bot;
        return (
          <div
            key={r.runId}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <StatusDot
              color={
                r.state === "failed"
                  ? "bg-red-500"
                  : r.state === "done" || r.running || r.state === "running"
                    ? "bg-emerald-500"
                    : "bg-muted-foreground/40"
              }
              pulse={r.running || r.state === "running"}
            />
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{r.name}</span>
            {r.kind === "pipeline" && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {r.stepsDone}/{r.stepsTotal}
              </span>
            )}
            <Badge className={`shrink-0 font-normal ${badge.className}`}>
              {badge.label}
            </Badge>
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
              {ago(r.startedAt)}
            </span>
            <a
              href={`${BASE_PATH}/logs?file=${encodeURIComponent(r.logFile)}&filter=${encodeURIComponent(r.runId)}`}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              title="Open in Logs"
            >
              <ExternalLink className="size-3.5" />
            </a>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={() => openRun(r.runId)}
            >
              Open
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground hover:text-red-600"
              title="Delete run"
              disabled={r.running}
              onClick={async () => {
                closeRun(r.runId);
                await deleteRunAction(r.runId);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
