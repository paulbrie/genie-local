"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Cpu, HardDrive, Menu, MemoryStick } from "lucide-react";

import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import type { SystemStats } from "@/lib/stats";
import { StatsHistoryChart } from "@/components/stats-history-chart";
import { mobileNav } from "@/store/ui";
import { AdminUpdateButton } from "@/components/admin-update-button";
import { CommandPaletteButton } from "@/components/command-palette";
import { PageTitle } from "@/components/desktop/desktop-menu";
import { SessionsIndicator } from "@/components/sessions-indicator";
import { ProjectsMemoryBadge } from "@/components/project-memory-badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;

/**
 * Slim top bar beside the sidebar: the page's name and its detach icon, live
 * system telemetry, search. Navigation, the Spiridus menu (on its logo) and the
 * theme/logout controls live in {@link AppSidebar}.
 */
export function StatsToolbar() {
  const pathname = usePathname();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState(false);

  const hidden = pathname === "/login";

  useEffect(() => {
    if (hidden) return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/stats`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data: SystemStats = await res.json();
        if (active) {
          setStats(data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [hidden]);

  if (hidden) return null;

  return (
    <header
      // (a layer over the content area's pop-ups, so the bar's own popovers open on top of them)
      className="relative z-30 flex h-10 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70 sm:gap-4"
    >
      {/* Mobile nav trigger — the sidebar is an off-canvas drawer below `md`. */}
      <button
        type="button"
        onClick={() => mobileNav.next(true)}
        aria-label="Open navigation"
        className="-ml-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground md:hidden"
      >
        <Menu className="size-5" />
      </button>
      <PageTitle />
      <div className="flex min-w-0 flex-1 items-center">
        <Gauges stats={stats} error={error} />
      </div>
      <ProjectsMemoryBadge />
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {error
          ? "stats unavailable"
          : stats
            ? `updated ${new Date(stats.ts).toLocaleTimeString()}`
            : "loading…"}
      </span>
      <CommandPaletteButton />
      <AdminUpdateButton />
      <SessionsIndicator />
      <StatsHistoryChart />
    </header>
  );
}

const GAUGES = {
  cpu: { label: "CPU", icon: Cpu },
  mem: { label: "Memory", icon: MemoryStick },
  disk: { label: "Disk", icon: HardDrive },
} as const;
type GaugeKind = keyof typeof GAUGES;

/** How full, as a colour: green, orange from 70%, red from 90% (the ring's, and its tooltip's bars'). */
const ringColor = (pct: number) => (pct >= 90 ? "text-destructive" : pct >= 70 ? "text-amber-500" : "text-emerald-500");
const barColor = (pct: number) => (pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500");

/**
 * CPU, memory and disk as three small rings, each its percent inside, green, orange as it fills up, red when nearly
 * full. The figures behind them are each one's tooltip: the percent, a bar, the sizes, and for the CPU every core's
 * load.
 */
function Gauges({ stats, error }: { stats: SystemStats | null; error: boolean }) {
  const none = error ? "Stats unavailable" : "Loading…";
  const free = (total: number, used: number) => `${formatBytes(used)} of ${formatBytes(total)} · ${formatBytes(Math.max(0, total - used))} free`;
  return (
    <TooltipProvider delay={120} closeDelay={60}>
      <div className="flex shrink-0 items-center gap-1">
        <Gauge kind="cpu" percent={stats?.cpuPercent ?? null} detail={stats ? `${stats.cpuCores} ${stats.cpuCores === 1 ? "core" : "cores"}` : none} cores={stats?.cpuPerCore ?? null} />
        <Gauge kind="mem" percent={stats?.memPercent ?? null} detail={stats ? free(stats.memTotalBytes, stats.memUsedBytes) : none} />
        <Gauge kind="disk" percent={stats?.diskPercent ?? null} detail={stats ? free(stats.diskTotalBytes, stats.diskUsedBytes) : none} />
      </div>
    </TooltipProvider>
  );
}

const R = 10;
const CIRC = 2 * Math.PI * R;

function Gauge({ kind, percent, detail, cores }: { kind: GaugeKind; percent: number | null; detail: string; cores?: number[] | null }) {
  const g = GAUGES[kind];
  const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const shown = percent == null ? "–" : `${Math.round(pct)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`${g.label} ${percent == null ? "unknown" : `${Math.round(pct)}%`}, ${detail}`}
        className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg viewBox="0 0 24 24" className="absolute inset-[3px] -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" className="stroke-foreground/10" />
          {percent != null && (
            <circle
              cx="12"
              cy="12"
              r={R}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              stroke="currentColor"
              strokeDasharray={`${(pct / 100) * CIRC} ${CIRC}`}
              className={cn("transition-[stroke-dasharray,color] duration-700 ease-out", ringColor(pct))}
            />
          )}
        </svg>
        <span className="relative font-mono text-[9px] leading-none font-semibold tabular-nums">{shown}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="block w-64 max-w-none px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <g.icon className="size-3.5 opacity-70" />
          <span className="font-medium">{g.label}</span>
          <span className="ml-auto font-mono text-sm font-semibold tabular-nums">{percent == null ? "–" : `${Math.round(pct)}%`}</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-background/20">
          <div className={cn("h-full rounded-full transition-[width] duration-700", barColor(pct))} style={{ width: `${pct}%` }} />
        </div>
        {/* (the CPU: every core's load, a thin bar each) */}
        {cores && cores.length > 1 && (
          <div className="mt-2 flex h-6 items-end gap-px" aria-hidden>
            {cores.map((c, i) => (
              <div key={i} className="relative h-full flex-1 overflow-hidden rounded-[1px] bg-background/15">
                <div className={cn("absolute inset-x-0 bottom-0", barColor(c))} style={{ height: `${Math.max(4, Math.min(100, c))}%` }} />
              </div>
            ))}
          </div>
        )}
        <p className="mt-1.5 font-mono text-[11px] opacity-70">{detail}</p>
      </TooltipContent>
    </Tooltip>
  );
}
