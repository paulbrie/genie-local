"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Rocket, ScrollText } from "lucide-react";

import { deployProdAction, deployStatusAction } from "@/app/actions";
import type { DeployStatus } from "@/lib/deploy";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";

// Log id (relative to /tmp) the deploy streams to — mirrors DEPLOY_LOG in
// @/lib/deploy (kept as a literal here since that module is server-only).
const DEPLOY_LOG = "projects/admin-deploy.log";
const POLL_MS = 3000;

/** Colour for a systemd is-active value. */
function unitDot(state: string): string {
  if (state === "active") return "bg-emerald-500";
  if (state === "activating") return "bg-amber-500";
  return "bg-muted-foreground/40";
}

function deployLabel(s: DeployStatus): { text: string; dot: string; pulse: boolean } {
  switch (s.deploy) {
    case "running":
      return { text: "Deploy running…", dot: "bg-amber-500", pulse: true };
    case "success":
      return { text: "Last deploy succeeded", dot: "bg-emerald-500", pulse: false };
    case "failed":
      return { text: "Last deploy FAILED", dot: "bg-red-500", pulse: false };
    default:
      return { text: "No deploy yet", dot: "bg-muted-foreground/40", pulse: false };
  }
}

/**
 * Build the prod bundle from the current source and restart the /admin (:3001)
 * server. This is how dev edits (validated on /admin-dev) reach production.
 * Dev start/stop is on this same page via the admin-dev.service row.
 */
export function DeployPanel() {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [migrate, setMigrate] = useState(false);
  const [isPending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const poll = useCallback(async () => {
    try {
      setStatus(await deployStatusAction());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void poll();
    };
    tick();
    timer.current = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer.current);
    };
  }, [poll]);

  const running = status?.deploy === "running" || isPending;

  const onDeploy = () => {
    if (
      !confirm(
        `Build and deploy to /admin now?${
          migrate ? "\n\nMigrations WILL run first." : ""
        }\n\nThe prod server restarts at the end (~a few seconds of downtime).`,
      )
    )
      return;
    startTransition(async () => {
      try {
        const res = await deployProdAction(migrate);
        if (res.ok) {
          toast.success("Deploy started — watch the log for progress");
          void poll();
        } else {
          toast.error(`Deploy failed to start: ${res.error ?? "unknown error"}`);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const d = status ? deployLabel(status) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4" /> Deploy to production
        </CardTitle>
        <CardDescription>
          Builds the current source into the prod bundle and restarts{" "}
          <code>/admin</code> (:3001). Iterate on{" "}
          <a
            href="/admin-dev"
            className="underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            /admin-dev
          </a>{" "}
          (:3002), then ship it here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5">
            <StatusDot color={unitDot(status?.prod ?? "")} label={`prod: ${status?.prod ?? "…"}`} />
            prod <span className="text-muted-foreground">{status?.prod ?? "…"}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot color={unitDot(status?.dev ?? "")} label={`dev: ${status?.dev ?? "…"}`} />
            dev <span className="text-muted-foreground">{status?.dev ?? "…"}</span>
          </span>
          {d && (
            <span className="flex items-center gap-1.5">
              <StatusDot color={d.dot} pulse={d.pulse} label={d.text} />
              <span className="text-muted-foreground">{d.text}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onDeploy} disabled={running} size="sm">
            <Rocket className="size-4" />
            {running ? "Deploying…" : "Build & Deploy"}
          </Button>

          <div className="flex items-center gap-2">
            <Checkbox
              id="deploy-migrate"
              checked={migrate}
              onCheckedChange={(v) => setMigrate(v === true)}
              disabled={running}
            />
            <Label htmlFor="deploy-migrate" className="text-sm font-normal">
              Run DB migrations first
            </Label>
          </div>

          <Link
            href={`/logs?file=${encodeURIComponent(DEPLOY_LOG)}`}
            className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <ScrollText className="size-3.5" /> Deploy log
          </Link>
        </div>

        {status?.dev !== "active" && (
          <p className="text-xs text-muted-foreground">
            Tip: the dev server (<code>admin-dev.service</code>) is{" "}
            {status?.dev ?? "…"}. Start it from the service row below to work on{" "}
            <code>/admin-dev</code>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
