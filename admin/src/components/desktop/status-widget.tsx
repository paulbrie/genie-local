"use client";

import { ChevronDown, ChevronUp, FolderKanban, MemoryStick, PanelLeft, PanelRight, SquareTerminal, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";

import { NAV_HREFS } from "@/components/nav-items";
import { ProjectContextMenu } from "@/components/project-context-menu";
import { TerminalContextMenu } from "@/components/terminal-context-menu";
import { fmtTokens, memoryTitle, shortBytes, termLabel, TermDot } from "@/components/nav-status";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import type { WidgetMode, WidgetSection } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { desk, openPathWindow, setWidget, setWidgetSide, toggleWidgetSection } from "@/store/desktop";
import { memoryOf, projectMemory } from "@/store/project-memory";
import { liveTerminals, openTerminal, type LiveTerminal, type TermStatus } from "@/store/terminals";

/** How wide it is: the icon grid keeps clear of it (IconGrid's `reserveRight`). */
export const STATUS_WIDGET_W = 300;

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

/**
 * The desktop's status widget, on the wallpaper at the top right (or left: its header's button moves it): every terminal with its state (the ones waiting
 * for you first), and every project with whether it's running, its ports and its tickets. A terminal opens as a
 * floating terminal; a project in a window (the one it's already in, if any). Folds to its header, or goes away
 * (the Spiridus menu brings it back).
 */
export function StatusWidget({ mode, side }: { mode: WidgetMode; side: "left" | "right" }) {
  const router = useRouter();
  const pathname = usePathname();
  const [terminals] = useSubject(liveTerminals);
  const [memory] = useSubject(projectMemory);
  const [{ widgetFolded }] = useSubject(desk);
  const isFolded = (s: WidgetSection) => !!widgetFolded?.includes(s);
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

  if (mode === "hidden") return null;
  const folded = mode === "collapsed";
  const terms = [...terminals].sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.name.localeCompare(b.name));
  const projs = [...(projects ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || a.slug.localeCompare(b.slug));
  const waiting = terminals.filter((t) => t.status === "claude-input").length;
  const working = terminals.filter((t) => t.status === "claude-working" || t.status === "busy").length;
  const running = (projects ?? []).filter((p) => p.running).length;

  // a project's page in the window already on it, else a new one (or the page's own window when that's closed)
  const openPath = (path: string) => {
    if (!openPathWindow(path, pathname, NAV_HREFS)) router.push(path);
  };
  const openProject = (slug: string) => openPath(`/projects/${encodeURIComponent(slug)}`);

  return (
    <aside
      aria-label="Terminals and projects"
      style={{ width: STATUS_WIDGET_W }}
      className={`absolute top-3 ${side === "left" ? "left-3" : "right-3"} flex max-h-[calc(100%-110px)] flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/55 text-foreground shadow-[0_18px_40px_-16px_rgb(0_0_0/0.35)] ring-1 ring-black/5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/55 dark:ring-white/5`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-semibold">Status</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {[
            waiting ? `${waiting} waiting for you` : null,
            working ? `${working} working` : null,
            projects ? `${running} running` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "all quiet"}
        </span>
        <button
          type="button"
          onClick={() => setWidgetSide(side === "left" ? "right" : "left")}
          aria-label={side === "left" ? "Move to the right" : "Move to the left"}
          title={side === "left" ? "Move to the right" : "Move to the left"}
          className="rounded-md p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          {side === "left" ? <PanelRight className="size-3.5" /> : <PanelLeft className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setWidget(folded ? "open" : "collapsed")}
          aria-label={folded ? "Unfold" : "Fold"}
          title={folded ? "Unfold" : "Fold"}
          className="rounded-md p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          {folded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setWidget("hidden")}
          aria-label="Hide (the Spiridus menu brings it back)"
          title="Hide (the Spiridus menu brings it back)"
          className="rounded-md p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {!folded && (
        <div className="scrollbar-clear flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          <Section
            icon={SquareTerminal}
            title="Terminals"
            count={terminals.length}
            note={waiting ? `${waiting} waiting` : undefined}
            folded={isFolded("terminals")}
            onToggle={() => toggleWidgetSection("terminals")}
          >
            {terms.length === 0 && <Empty>No terminals.</Empty>}
            {terms.map((t) => (
              // (right-click: the sidebar's menu, the same options as in the classic view)
              <TerminalContextMenu key={t.name} name={t.name} claude={t.status.startsWith("claude")} onNavigate={() => {}}>
                <TerminalRow t={t} onOpen={() => openTerminal(t.name)} />
              </TerminalContextMenu>
            ))}
          </Section>
          <Section
            icon={FolderKanban}
            title="Projects"
            count={projects?.length ?? null}
            note={running ? `${running} running` : undefined}
            folded={isFolded("projects")}
            onToggle={() => toggleWidgetSection("projects")}
          >
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
          </Section>
        </div>
      )}
    </aside>
  );
}

/** The sidebar's sub-item row (app-sidebar.tsx): its size, padding and indent under the heading's label. */
const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";

/**
 * A heading as the sidebar's groups have it (its icon, label and count, a chevron that folds it: remembered in
 * desk.widgetFolded), its rows under it.
 */
function Section({
  icon: Icon,
  title,
  count,
  note,
  folded,
  onToggle,
  children,
}: {
  icon: typeof SquareTerminal;
  title: string;
  count: number | null;
  /** said beside the heading while it's folded, so it still tells what matters */
  note?: string;
  folded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
        <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] leading-5">
          <Icon className="size-[15px] shrink-0" />
          <span className="truncate">{title}</span>
          {folded && note && <span className="truncate text-xs opacity-70">{note}</span>}
          {count !== null && <span className="ml-auto text-xs tabular-nums opacity-60">{count}</span>}
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${folded ? "Unfold" : "Fold"} ${title}`}
          title={folded ? "Unfold" : "Fold"}
          className="mr-1 rounded p-0.5 opacity-70 hover:bg-accent hover:opacity-100"
        >
          <ChevronDown className={`size-3.5 transition-transform ${folded ? "-rotate-90" : ""}`} />
        </button>
      </div>
      {!folded && <div className="mt-px flex flex-col gap-px">{children}</div>}
    </div>
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
      <span className="min-w-0 truncate">{t.name}</span>
      <span
        className={cn(
          "ml-auto shrink-0 text-[10px]",
          t.status === "claude-input" ? "font-medium text-red-600 dark:text-red-400" : t.status === "claude-working" ? "text-amber-700 dark:text-amber-400" : "opacity-70",
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-0.5 pr-2 pl-7 text-xs text-muted-foreground">{children}</p>;
}
