"use client";

import { useMemo, useState, useTransition } from "react";
import { Bot, Eraser, ExternalLink, RotateCw, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import {
  clearFinishedRunsAction,
  deleteRunAction,
  rerunRunAction,
} from "@/app/actions";
import { LIFECYCLE_BADGE } from "@/components/run-console";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import type { RunLifecycle } from "@/lib/agent-run-types";
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

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

const ACTIVE: RunLifecycle[] = ["queued", "starting", "running"];

/**
 * The agent-run history: every run (active + finished), newest first, read from
 * the shared `activeRuns` subject that <RunDock> keeps fresh. Filterable by text
 * and state; each row opens/re-runs/deletes. "Clear finished" prunes the lot.
 */
export function RunHistory() {
  const [runs] = useSubject(activeRuns);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [pending, start] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q))
        return false;
      if (stateFilter === "active")
        return r.running || ACTIVE.includes(r.state);
      if (stateFilter === "done") return r.state === "done";
      if (stateFilter === "failed")
        return r.state === "failed" || r.state === "stopped";
      return true;
    });
  }, [runs, query, stateFilter]);

  const finishedCount = runs.filter((r) => !r.running).length;

  function clearFinished() {
    if (!confirm(`Delete all ${finishedCount} finished run(s) from history?`))
      return;
    start(async () => {
      try {
        for (const r of runs) if (!r.running) closeRun(r.runId);
        const n = await clearFinishedRunsAction();
        toast.success(`Cleared ${n} run${n === 1 ? "" : "s"}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  async function rerun(runId: string) {
    try {
      const newId = await rerunRunAction(runId);
      openRun(newId);
      toast.success("Re-running with the same inputs");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No runs yet. Start one from an agent or pipeline above.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name…"
          className="h-8 max-w-48 text-sm"
        />
        <div className="flex gap-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStateFilter(f.value)}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${
                stateFilter === f.value
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {filtered.length} of {runs.length}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={pending || finishedCount === 0}
          onClick={clearFinished}
          title="Delete all finished runs"
        >
          <Eraser className="size-3.5" />
          Clear finished
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No runs match.
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((r) => {
            const badge = LIFECYCLE_BADGE[r.state];
            const Icon = r.kind === "pipeline" ? Workflow : Bot;
            return (
              <div key={r.runId} className="flex items-center gap-3 px-3 py-2 text-sm">
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
                {r.costUsd != null && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    ${r.costUsd.toFixed(4)}
                  </span>
                )}
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
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground"
                  title="Re-run with the same inputs"
                  disabled={r.running}
                  onClick={() => rerun(r.runId)}
                >
                  <RotateCw className="size-3.5" />
                </Button>
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
      )}
    </div>
  );
}
