"use client";

import { RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { delegateTargetsAction, delegateTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import type { Task } from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";
import type { DelegateTarget } from "@/lib/task-delegate";

const STATE: Record<string, { label: string; color: string }> = {
  "claude-idle": { label: "idle", color: "bg-emerald-500" },
  "claude-working": { label: "working · the brief waits its turn", color: "bg-sky-500" },
  "claude-input": { label: "waiting on a prompt · answer it first", color: "bg-amber-500" },
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Hand a ticket to one of the live Claude terminals: it gets a one-line brief
 * typed in (read ticket #N through the local-genie MCP, move it along, comment
 * back) and becomes the ticket's assignee.
 */
export function TaskDelegate({ slug, task }: { slug: string; task: Task }) {
  const [targets, setTargets] = useState<DelegateTarget[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();

  const load = useCallback(() => {
    startLoading(async () => {
      try {
        setTargets(await delegateTargetsAction(slug));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setTargets([]);
      }
    });
  }, [slug]);
  useEffect(load, [load]);

  function delegate() {
    if (!picked) return;
    startSending(async () => {
      try {
        const { queued } = await delegateTaskAction(slug, task.id, picked, note || null);
        toast.success(
          queued
            ? `Brief queued in ${picked}: it starts after its current turn`
            : `Delegated #${task.id} to ${picked}`,
        );
        setNote("");
        load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-2">
      {task.assignee && (
        <p className="text-xs">
          Assigned to <span className="font-medium">{task.assignee}</span>
          <span className="text-muted-foreground"> · {formatRelativeTime(task.assignedAt)}</span>
        </p>
      )}
      <div className="overflow-hidden rounded-md border">
        <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          <span>Claude terminals</span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh terminals"
            className="rounded p-0.5 hover:text-foreground"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {targets == null ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : targets.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No Claude terminal is running. Start one from Terminals.
          </p>
        ) : (
          <ul role="radiogroup" aria-label="Claude terminals" className="max-h-56 divide-y overflow-y-auto">
            {targets.map((t) => {
              const state = STATE[t.status] ?? { label: t.status, color: "bg-muted-foreground" };
              const selected = picked === t.name;
              return (
                <li key={t.name}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!t.canSend}
                    onClick={() => setPicked(t.name)}
                    className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      selected ? "bg-primary/10" : "hover:bg-muted/60"
                    }`}
                  >
                    <StatusDot color={state.color} pulse={t.status === "claude-working"} label={state.label} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{t.name}</span>
                        {t.inProject && (
                          <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">
                            this project
                          </span>
                        )}
                        {task.assignee === t.name && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            assigned
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {state.label} · {t.cwd.replace(/^\/opt\/project\/projects\//, "")}
                      </span>
                    </span>
                    {t.tokens != null && (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {fmtTokens(t.tokens)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the agent (optional)"
          aria-label="Note for the agent"
          className="h-8 text-xs md:text-xs"
        />
        <Button size="sm" disabled={!picked || sending} onClick={delegate} className="shrink-0">
          <Send className="size-3.5" />
          {sending ? "Sending…" : picked ? `Delegate to ${picked}` : "Delegate"}
        </Button>
      </div>
    </div>
  );
}
