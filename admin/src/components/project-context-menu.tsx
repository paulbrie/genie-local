"use client";

import { FileCode2, GitBranch, KanbanSquare, ListChecks, NotebookPen, SquareTerminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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

type AppScripts = { app: string; scripts: { name: string; running: boolean }[] };

/**
 * Right-click on a project in the sidebar: its tabs (Scripts ▸ every script,
 * Tasks, Notes, Git). A script opens the Scripts tab on it; nothing is run.
 */
export function ProjectContextMenu({
  slug,
  hasGit,
  ports,
  onNavigate,
  children,
}: {
  slug: string;
  hasGit: boolean;
  /** Ports of its running apps. */
  ports: number[];
  onNavigate: () => void;
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
                      <ContextMenuItem
                        key={s.name}
                        onClick={() =>
                          go(`${base}/scripts?script=${encodeURIComponent(`${a.app}:${s.name}`)}`)
                        }
                      >
                        <StatusDot
                          color={s.running ? "bg-emerald-500" : "bg-muted-foreground/30"}
                          pulse={s.running}
                          size="sm"
                          label={s.running ? "Running" : "Stopped"}
                        />
                        <span className="truncate font-mono text-xs">{s.name}</span>
                      </ContextMenuItem>
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
