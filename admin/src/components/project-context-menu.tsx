"use client";

import {
  Crosshair,
  FileCode2,
  GitBranch,
  KanbanSquare,
  ListChecks,
  NotebookPen,
  Play,
  RotateCw,
  ExternalLink,
  ScrollText,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { restartAppAction, startAppAction, stopAppAction } from "@/app/actions";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { RunStatus } from "@/lib/runner";
import { runSlug } from "@/lib/run-slug";

type AppScripts = {
  app: string;
  appId: number;
  port: number | null;
  /** Site-root path of the live app through nginx; null without a port. */
  url: string | null;
  scripts: { name: string; running: boolean }[];
};

type ScriptOp = "start" | "stop" | "restart";
const OPS: Record<ScriptOp, { run: typeof startAppAction; doing: string; done: string }> = {
  start: { run: startAppAction, doing: "starting", done: "started" },
  stop: { run: stopAppAction, doing: "stopping", done: "stopped" },
  restart: { run: restartAppAction, doing: "restarting", done: "restarted" },
};

/**
 * Right-click on a project in the sidebar: its tabs (Scripts ▸ every script,
 * Tasks, Notes, Git). Each script has its own menu: Start, or Stop / Restart
 * when it runs, plus Show in the Scripts tab and its Logs.
 */
export function ProjectContextMenu({
  slug,
  hasGit,
  ports,
  onNavigate,
  onChanged,
  children,
}: {
  slug: string;
  hasGit: boolean;
  /** Ports of its running apps. */
  ports: number[];
  onNavigate: () => void;
  /** A script was started / stopped: the sidebar reloads its running state. */
  onChanged: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [apps, setApps] = useState<AppScripts[] | null>(null);
  const [failed, setFailed] = useState(false);
  const base = `/projects/${encodeURIComponent(slug)}`;

  const go = (href: string) => {
    router.push(href);
    onNavigate();
  };

  // Scripts are read when the menu opens, so they're current (and running dots live).
  const load = async () => {
    setFailed(false);
    try {
      const res = await fetch(`${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/scripts`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      setApps(((await res.json()) as { apps: AppScripts[] }).apps);
    } catch {
      setFailed(true);
    }
  };

  function runOp(op: ScriptOp, a: AppScripts, script: string) {
    const label = `${slug}${a.app ? `/${a.app}` : ""} ${script}`;
    const pending = toast.loading(`${label}: ${OPS[op].doing}…`);
    OPS[op]
      .run(slug, a.appId, script)
      .then((status: RunStatus) => {
        toast.success(`${label} ${OPS[op].done}${status.running && status.pid ? ` (pid ${status.pid})` : ""}`, {
          id: pending,
        });
        // The dot in this menu now; the sidebar's dot and port after a reload.
        setApps((cur) =>
          cur?.map((x) =>
            x.appId !== a.appId
              ? x
              : { ...x, scripts: x.scripts.map((s) => (s.name === script ? { ...s, running: status.running } : s)) },
          ) ?? cur,
        );
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(`${label}: ${err instanceof Error ? err.message : String(err)}`, { id: pending });
      });
  }

  const multiApp = (apps?.length ?? 0) > 1;
  const scriptCount = apps?.reduce((n, a) => n + a.scripts.length, 0) ?? 0;

  return (
    <ContextMenu onOpenChange={(open) => open && void load()}>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuLabel className="flex items-center gap-2">
          <span className="truncate">{slug}</span>
          {ports.length > 0 && (
            <span className="ml-auto shrink-0 font-mono text-emerald-700 dark:text-emerald-400">
              running :{ports.join(" :")}
            </span>
          )}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {/* The live site(s): a raw URL outside the admin's basePath, in a new tab. */}
        {apps
          ?.filter((a) => a.url)
          .map((a) => (
            <ContextMenuItem
              key={`url-${a.appId}`}
              onClick={() => window.open(a.url!, "_blank", "noopener,noreferrer")}
              title={`${window.location.origin}${a.url}`}
            >
              <ExternalLink />
              <span className="truncate">Open {multiApp ? (a.app || "(root)") : "site"}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">:{a.port}</span>
            </ContextMenuItem>
          ))}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <SquareTerminal />
            Scripts
            {apps && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{scriptCount}</span>}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60">
            <ContextMenuItem onClick={() => go(`${base}/scripts`)}>
              <ListChecks />
              All scripts
            </ContextMenuItem>
            <ContextMenuSeparator />
            {failed ? (
              <ContextMenuLabel>Couldn&apos;t load the scripts</ContextMenuLabel>
            ) : !apps ? (
              <ContextMenuLabel>Loading…</ContextMenuLabel>
            ) : scriptCount === 0 ? (
              <ContextMenuLabel>No scripts</ContextMenuLabel>
            ) : (
              apps
                .filter((a) => a.scripts.length > 0)
                .map((a) => (
                  <ContextMenuGroup key={a.app}>
                    {multiApp && <ContextMenuGroupLabel>{a.app || "(root)"}</ContextMenuGroupLabel>}
                    {a.scripts.map((s) => (
                      <ContextMenuSub key={s.name}>
                        <ContextMenuSubTrigger>
                          <StatusDot
                            color={s.running ? "bg-emerald-500" : "bg-muted-foreground/30"}
                            pulse={s.running}
                            size="sm"
                            label={s.running ? "Running" : "Stopped"}
                          />
                          <span className="truncate font-mono text-xs">{s.name}</span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                          {s.running ? (
                            <>
                              <ContextMenuItem onClick={() => runOp("stop", a, s.name)}>
                                <Square />
                                Stop
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => runOp("restart", a, s.name)}>
                                <RotateCw />
                                Restart
                              </ContextMenuItem>
                            </>
                          ) : (
                            <ContextMenuItem onClick={() => runOp("start", a, s.name)}>
                              <Play />
                              Start
                            </ContextMenuItem>
                          )}
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() =>
                              go(`${base}/scripts?script=${encodeURIComponent(`${a.app}:${s.name}`)}`)
                            }
                          >
                            <Crosshair />
                            Show in Scripts
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              go(
                                // Filtered down to this script's own log.
                                `/logs?file=${encodeURIComponent(`projects/${runSlug(slug, a.app, s.name)}.log`)}&filter=${encodeURIComponent(runSlug(slug, a.app, s.name))}`,
                              )
                            }
                          >
                            <ScrollText />
                            Logs
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    ))}
                  </ContextMenuGroup>
                ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => go(`${base}/tasks`)}>
          <KanbanSquare />
          Tasks
        </ContextMenuItem>
        <ContextMenuItem onClick={() => go(`${base}/notes`)}>
          <NotebookPen />
          Notes
        </ContextMenuItem>
        {hasGit && (
          <ContextMenuItem onClick={() => go(`${base}/git`)}>
            <GitBranch />
            Git
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => go("/projects")}>
          <FileCode2 />
          All projects
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
