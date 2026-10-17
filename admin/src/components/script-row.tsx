"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  appStatusesAction,
  restartAppAction,
  startAppAction,
  stopAppAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { runSlug } from "@/lib/run-slug";
import type { RunStatus } from "@/lib/runner";

const POLL_MS = 5000;

/**
 * An app's scripts, with ONE status poll for all of them. Server actions run
 * one at a time on the client, so a poll per row (41 rows on some apps) kept
 * that queue permanently busy and other actions (Add task…) never got a turn.
 */
export function ScriptList({
  projectSlug,
  appSlug,
  appId,
  scripts,
  initial,
}: {
  projectSlug: string;
  appSlug: string;
  appId: number;
  scripts: { name: string; command: string }[];
  initial: RunStatus[];
}) {
  const [statuses, setStatuses] = useState<Record<string, RunStatus>>(() =>
    Object.fromEntries(scripts.map((s, i) => [s.name, initial[i]])),
  );
  const namesKey = scripts.map((s) => s.name).join("\n");

  // ?script=<app>:<name> (the sidebar's right-click menu): bring that row into
  // view and mark it.
  const focus = useSearchParams().get("script");
  const focused = focus?.startsWith(`${appSlug}:`) ? focus.slice(appSlug.length + 1) : null;
  useEffect(() => {
    if (!focused) return;
    document
      .querySelector(`[data-app="${CSS.escape(appSlug)}"] [data-script="${CSS.escape(focused)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [appSlug, focused]);

  useEffect(() => {
    const names = namesKey.split("\n");
    let active = true;
    let inFlight = false;
    const id = setInterval(async () => {
      // Skip a tick rather than queue behind a slow poll or a hidden tab.
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await appStatusesAction(projectSlug, appId, names);
        if (active) setStatuses((prev) => ({ ...prev, ...next }));
      } catch {
        /* keep last known */
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [projectSlug, appId, namesKey]);

  return (
    <div data-app={appSlug} className="divide-y rounded-md border">
      {scripts.map(({ name, command }, i) => (
        <ScriptRow
          highlighted={name === focused}
          key={name}
          projectSlug={projectSlug}
          appSlug={appSlug}
          appId={appId}
          script={name}
          command={command}
          status={statuses[name] ?? initial[i]}
          onStatus={(s) => setStatuses((prev) => ({ ...prev, [name]: s }))}
        />
      ))}
    </div>
  );
}

function ScriptRow({
  projectSlug,
  appSlug,
  appId,
  script,
  command,
  status,
  onStatus,
  highlighted,
}: {
  projectSlug: string;
  appSlug: string;
  appId: number;
  script: string;
  command: string;
  status: RunStatus;
  onStatus: (s: RunStatus) => void;
  highlighted: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<RunStatus>, okMsg: string) {
    startTransition(async () => {
      try {
        onStatus(await fn());
        toast.success(`${script}: ${okMsg}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const running = status.running;

  return (
    <div
      data-script={script}
      aria-current={highlighted ? "true" : undefined}
      className={`flex items-center gap-2 px-2.5 py-1.5 transition-colors ${
        highlighted ? "bg-primary/10 ring-1 ring-primary/40 ring-inset" : ""
      }`}
    >
      <StatusDot
        color={running ? "bg-emerald-500" : "bg-muted-foreground/30"}
        pulse={running}
        label={running ? `Running (pid ${status.pid})` : "Stopped"}
      />

      <code className="w-24 shrink-0 truncate font-mono text-xs font-semibold">
        {script}
      </code>
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        title={command}
      >
        {command}
      </code>

      <div className="flex shrink-0 items-center gap-1">
        {running ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={isPending}
              onClick={() =>
                run(
                  () => restartAppAction(projectSlug, appId, script),
                  "restarted",
                )
              }
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={isPending}
              onClick={() =>
                run(() => stopAppAction(projectSlug, appId, script), "stopped")
              }
            >
              Stop
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={isPending}
            onClick={() =>
              run(() => startAppAction(projectSlug, appId, script), "started")
            }
          >
            {isPending ? "…" : "Run"}
          </Button>
        )}
        <Link
          href={`/logs?file=${encodeURIComponent(status.logFile)}&filter=${encodeURIComponent(runSlug(projectSlug, appSlug))}`}
          className="px-1 text-xs text-muted-foreground hover:underline"
        >
          logs
        </Link>
      </div>
    </div>
  );
}
