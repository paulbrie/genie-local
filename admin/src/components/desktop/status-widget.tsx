"use client";

import { ChevronDown, ChevronRight, ChevronUp, FolderKanban, PanelLeft, PanelRight, SquareTerminal, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";

import { NAV_HREFS } from "@/components/nav-items";
import { statusLabel, TermStatusDot } from "@/components/terminal-dock";
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

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

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
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (mode === "hidden") return null;
  const folded = mode === "collapsed";
  const terms = [...terminals].sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.name.localeCompare(b.name));
  const projs = [...(projects ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || a.slug.localeCompare(b.slug));
  const waiting = terminals.filter((t) => t.status === "claude-input").length;
  const working = terminals.filter((t) => t.status === "claude-working" || t.status === "busy").length;
  const running = (projects ?? []).filter((p) => p.running).length;

  const openProject = (slug: string) => {
    const path = `/projects/${encodeURIComponent(slug)}`;
    if (!openPathWindow(path, pathname, NAV_HREFS)) router.push(path);
  };

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
        <div className="scrollbar-clear min-h-0 overflow-y-auto px-1.5 pb-2">
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
              <TerminalRow key={t.name} t={t} onOpen={() => openTerminal(t.name)} />
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
              const mem = memoryOf(memory, p.slug)?.bytes ?? 0;
              return (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => openProject(p.slug)}
                  title={`${p.slug}${p.running ? ` · running${p.ports.length ? ` on :${p.ports.join(", :")}` : ""}` : " · not running"} · ${p.openTasks} ticket${p.openTasks === 1 ? "" : "s"} to do${p.inProgress ? ` (${p.inProgress} in progress)` : ""}`}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left text-[12.5px] leading-5 hover:bg-foreground/[0.07]"
                >
                  <StatusDot
                    color={p.running ? "bg-emerald-500" : "bg-muted-foreground/30"}
                    pulse={p.running}
                    size="sm"
                    label={p.running ? "Running" : "Not running"}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.slug}</span>
                  {p.ports.length > 0 && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">:{p.ports.join(" :")}</span>}
                  {mem > 0 && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{bytes(mem)}</span>}
                  {p.openTasks > 0 && (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 text-[10.5px] tabular-nums",
                        p.inProgress ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-foreground/10 text-muted-foreground",
                      )}
                    >
                      {p.openTasks}
                    </span>
                  )}
                </button>
              );
            })}
          </Section>
        </div>
      )}
    </aside>
  );
}

/** A heading that folds its list (remembered: desk.widgetFolded); the list indented under the heading's title. */
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
  /** said beside the heading, so a folded section still tells what matters */
  note?: string;
  folded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform duration-150", !folded && "rotate-90")} />
        <Icon className="size-3" />
        {title}
        {count !== null && <span className="font-normal tabular-nums">{count}</span>}
        {note && <span className="ml-auto font-normal tracking-normal normal-case">{note}</span>}
      </button>
      {!folded && <div className="ml-4">{children}</div>}
    </div>
  );
}

function TerminalRow({ t, onOpen }: { t: LiveTerminal; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${t.name}: ${statusLabel(t.status)}${t.background ? ` (${t.background})` : ""}${t.memBytes ? ` · ${bytes(t.memBytes)} in memory` : ""}`}
      className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left text-[12.5px] leading-5 hover:bg-foreground/[0.07]"
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <TermStatusDot status={t.status} />
      </span>
      <span className="min-w-0 flex-1 truncate">{t.name}</span>
      <span
        className={cn(
          "shrink-0 text-[11px]",
          t.status === "claude-input" ? "font-medium text-red-600 dark:text-red-400" : t.status === "claude-working" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        {SHORT[t.status]}
      </span>
      {t.memBytes ? <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{bytes(t.memBytes)}</span> : null}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-0.5 text-[12px] text-muted-foreground">{children}</p>;
}
