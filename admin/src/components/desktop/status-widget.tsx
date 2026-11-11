"use client";

import { FolderKanban, MemoryStick, SquareTerminal } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";

import { NAV_HREFS } from "@/components/nav-items";
import { ProjectContextMenu } from "@/components/project-context-menu";
import { TerminalContextMenu } from "@/components/terminal-context-menu";
import { Empty, ROW, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { fmtTokens, memoryTitle, shortBytes, termLabel, TermDot } from "@/components/nav-status";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import { cn } from "@/lib/utils";
import { openPathWindow } from "@/store/desktop";
import { memoryOf, projectMemory } from "@/store/project-memory";
import { liveTerminals, openTerminal, type LiveTerminal, type TermStatus } from "@/store/terminals";

// The desktop's two widgets, as their frame (desktop.tsx's WidgetFrame) holds them: a header, which is the grip it's
// dragged by, then the list. Where they are and how big is the frame's business; folded or hidden is desk.widgets.

// (the ones that need you first, then those at work, then the rest)
const URGENCY: Record<TermStatus, number> = {
  "claude-input": 0,
  "claude-working": 1,
  "claude-background": 2,
  busy: 3,
  "claude-idle": 4,
  idle: 5,
};

const SHORT: Record<TermStatus, string> = {
  "claude-input": "waiting for you",
  "claude-working": "working",
  "claude-background": "in the background",
  busy: "running a command",
  "claude-idle": "ready",
  idle: "shell",
};

/** Every terminal with its state, the ones waiting for you first; one opens as a floating terminal. */
export function TerminalsWidget({ folded }: { folded: boolean }) {
  const [terminals] = useSubject(liveTerminals);
  const terms = [...terminals].sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.name.localeCompare(b.name));
  const waiting = terminals.filter((t) => t.status === "claude-input").length;
  const working = terminals.filter((t) => t.status === "claude-working" || t.status === "busy").length;
  return (
    <>
      <WidgetHeader
        id="terminals"
        icon={SquareTerminal}
        title="Terminals"
        count={terminals.length}
        note={[waiting ? `${waiting} waiting for you` : null, working ? `${working} working` : null].filter(Boolean).join(" · ") || "all quiet"}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {terms.length === 0 && <Empty>No terminals.</Empty>}
          {terms.map((t) => (
            // (right-click: the sidebar's menu, the same options as in the classic view)
            <TerminalContextMenu key={t.name} name={t.name} claude={t.status.startsWith("claude")} onNavigate={() => {}}>
              <TerminalRow t={t} onOpen={() => openTerminal(t.name)} />
            </TerminalContextMenu>
          ))}
        </WidgetList>
      )}
    </>
  );
}

/** Every project with whether it's running, its ports, memory and tickets; one opens in a window (the one already on it, if any). */
export function ProjectsWidget({ folded }: { folded: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [memory] = useSubject(projectMemory);
  const [projects, setProjects] = useState<ProjectNavItem[] | null>(null);
  // bumped after a script is started or stopped from a project's menu: its running state, now and once it's bound
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/projects`, { cache: "no-store" });
        if (!r.ok) return;
        const json = (await r.json()) as { projects?: ProjectNavItem[] };
        if (live && json.projects) setProjects(json.projects);
      } catch {
        /* keep the last list */
      }
    };
    void load();
    const soon = reload ? setTimeout(load, 2500) : undefined;
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
      clearTimeout(soon);
    };
  }, [reload]);

  const projs = [...(projects ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || a.slug.localeCompare(b.slug));
  const running = (projects ?? []).filter((p) => p.running).length;

  // a project's page in the window already on it, else a new one (or the page's own window when that's closed)
  const openPath = (path: string) => {
    if (!openPathWindow(path, pathname, NAV_HREFS)) router.push(path);
  };
  const openProject = (slug: string) => openPath(`/projects/${encodeURIComponent(slug)}`);

  return (
    <>
      <WidgetHeader
        id="projects"
        icon={FolderKanban}
        title="Projects"
        count={projects?.length ?? null}
        note={projects ? (running ? `${running} running` : "none running") : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {projects === null && <Empty>Loading…</Empty>}
          {projects?.length === 0 && <Empty>No projects.</Empty>}
          {projs.map((p) => {
            const mem = memoryOf(memory, p.slug);
            const limit = memory?.limits[p.slug];
            const over = !!mem && !!limit && mem.bytes > limit * 1024 * 1024;
            const memText = mem && mem.bytes > 0 ? shortBytes(mem.bytes) : null;
            return (
              <ProjectContextMenu
                key={p.slug}
                slug={p.slug}
                hasGit={p.hasGit}
                ports={p.ports}
                onNavigate={() => {}}
                onChanged={() => setReload((n) => n + 1)}
                navigate={openPath}
              >
                <button
                  type="button"
                  onClick={() => openProject(p.slug)}
                  title={`${p.slug}${p.running ? ` · running${p.ports.length ? ` on :${p.ports.join(", :")}` : ""}` : ""}${mem ? ` · ${memoryTitle(mem)}${limit ? ` (limit ${shortBytes(limit * 1024 * 1024)})` : ""}` : ""} · ${p.openTasks} ticket${p.openTasks === 1 ? "" : "s"} to do${p.inProgress ? ` (${p.inProgress} in progress)` : ""}`}
                  className={ROW}
                >
                  <StatusDot
                    color={p.running ? "bg-emerald-500" : "bg-muted-foreground/30"}
                    pulse={p.running}
                    size="sm"
                    label={p.running ? "Running" : "Not running"}
                  />
                  <span className="truncate">{p.slug}</span>
                  {p.ports.length > 0 && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">:{p.ports.join(" :")}</span>
                  )}
                  {memText && (
                    <span className={`shrink-0 font-mono text-[10px] tabular-nums ${p.ports.length > 0 ? "" : "ml-auto"} ${over ? "font-semibold text-destructive" : "opacity-70"}`}>
                      {memText}
                    </span>
                  )}
                  {p.openTasks > 0 && (
                    <span className={`shrink-0 tabular-nums opacity-70 ${p.ports.length > 0 || memText ? "" : "ml-auto"}`}>{p.openTasks}</span>
                  )}
                </button>
              </ProjectContextMenu>
            );
          })}
        </WidgetList>
      )}
    </>
  );
}

function TerminalRow({ t, onOpen }: { t: LiveTerminal; onOpen: () => void }) {
  const tokens = t.tokens && t.tokens.total > 0 ? t.tokens.total : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${t.name} — ${termLabel(t.status)}${t.background ? ` (${t.background})` : ""}${t.tokens ? ` · ↑ ${t.tokens.input.toLocaleString()} / ↓ ${t.tokens.output.toLocaleString()} tokens this session` : ""}${t.memBytes ? ` · ${shortBytes(t.memBytes)} in memory` : ""}`}
      className={ROW}
    >
      <TermDot status={t.status} />
      <span className="min-w-0 flex-1 truncate">{t.name}</span>
      {/* (in a narrow widget, only the words that need you or are news: the dot says the rest) */}
      <span
        className={cn(
          "shrink-0 text-[10px]",
          t.status === "claude-input"
            ? "font-medium text-red-600 dark:text-red-400"
            : t.status === "claude-working"
              ? "text-amber-700 dark:text-amber-400"
              : "hidden opacity-70 @xs:inline",
        )}
      >
        {SHORT[t.status]}
      </span>
      {tokens > 0 && <span className="shrink-0 font-mono tabular-nums opacity-70">{fmtTokens(tokens)}</span>}
      {!!t.memBytes && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums opacity-70">
          <MemoryStick className="size-2.5" />
          {shortBytes(t.memBytes)}
        </span>
      )}
    </button>
  );
}
