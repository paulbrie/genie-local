"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  appStatusAction,
  restartAppAction,
  startAppAction,
  stopAppAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { runSlug } from "@/lib/run-slug";
import type { RunStatus } from "@/lib/runner";

const POLL_MS = 5000;

export function ScriptRow({
  projectSlug,
  appSlug,
  appId,
  script,
  command,
  initial,
}: {
  projectSlug: string;
  appSlug: string;
  appId: number;
  script: string;
  command: string;
  initial: RunStatus;
}) {
  const [status, setStatus] = useState<RunStatus>(initial);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    const id = setInterval(async () => {
      try {
        const s = await appStatusAction(projectSlug, appId, script);
        if (active) setStatus(s);
      } catch {
        /* keep last known */
      }
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [projectSlug, appId, script]);

  function run(fn: () => Promise<RunStatus>, okMsg: string) {
    startTransition(async () => {
      try {
        setStatus(await fn());
        toast.success(`${script}: ${okMsg}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const running = status.running;

  return (
    <div data-script={script} className="flex items-center gap-2 px-2.5 py-1.5">
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
