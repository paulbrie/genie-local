"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu } from "lucide-react";

import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import type { SystemStats } from "@/lib/stats";
import { StatsHistoryChart } from "@/components/stats-history-chart";
import { mobileNav } from "@/store/ui";
import { AdminUpdateButton } from "@/components/admin-update-button";
import { SessionsIndicator } from "@/components/sessions-indicator";
import { ProjectsMemoryBadge } from "@/components/project-memory-badge";

const POLL_MS = 5000;

/**
 * Slim top bar showing live system telemetry. Navigation and the theme/logout
 * controls live in {@link AppSidebar}; this is telemetry only.
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
    <header className="flex h-10 shrink-0 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Mobile nav trigger — the sidebar is an off-canvas drawer below `md`. */}
      <button
        type="button"
        onClick={() => mobileNav.next(true)}
        aria-label="Open navigation"
        className="-ml-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground md:hidden"
      >
        <Menu className="size-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3 xl:gap-5">
        <Metric
          label="CPU"
          percent={stats?.cpuPercent ?? null}
          detail={
            stats
              ? `${Math.round(stats.cpuPercent)}% · ${stats.cpuCores} ${
                  stats.cpuCores === 1 ? "core" : "cores"
                }`
              : error
                ? "—"
                : "…"
          }
        />
        <Metric
          label="MEM"
          percent={stats?.memPercent ?? null}
          detail={
            stats
              ? `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)}`
              : error
                ? "—"
                : "…"
          }
        />
        <Metric
          label="DISK"
          percent={stats?.diskPercent ?? null}
          detail={
            stats
              ? `${formatBytes(stats.diskUsedBytes)} / ${formatBytes(stats.diskTotalBytes)}`
              : error
                ? "—"
                : "…"
          }
        />
      </div>
      <ProjectsMemoryBadge />
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {error
          ? "stats unavailable"
          : stats
            ? `updated ${new Date(stats.ts).toLocaleTimeString()}`
            : "loading…"}
      </span>
      <AdminUpdateButton />
      <SessionsIndicator />
      <StatsHistoryChart />
    </header>
  );
}

function ringColor(percent: number): string {
  if (percent >= 90) return "text-destructive";
  if (percent >= 70) return "text-amber-500";
  return "text-emerald-500";
}

const R = 9.5;
const CIRC = 2 * Math.PI * R;

/**
 * One metric as a small ring gauge with its percent inside and its label beside it; the details (sizes, cores) are
 * its tooltip, and shown inline too on wide screens. Small enough that the bar never needs to scroll.
 */
function Metric({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number | null;
  detail: string;
}) {
  const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="flex shrink-0 items-center gap-1.5" title={`${label}: ${detail}`}>
      <span className="relative inline-flex size-[26px] shrink-0 items-center justify-center">
        <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" className="stroke-muted" />
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
              className={`transition-all duration-500 ${ringColor(pct)}`}
            />
          )}
        </svg>
        <span className="relative font-mono text-[9px] font-medium tabular-nums">
          {percent == null ? "–" : Math.round(pct)}
        </span>
      </span>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="hidden whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground xl:inline">{detail}</span>
      <span className="sr-only">
        {label} {percent == null ? "unknown" : `${Math.round(pct)}%`}, {detail}
      </span>
    </div>
  );
}
