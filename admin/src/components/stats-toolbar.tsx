"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu } from "lucide-react";

import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import type { SystemStats } from "@/lib/stats";
import { StatsHistoryChart } from "@/components/stats-history-chart";
import { mobileNav } from "@/store/ui";

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
      <div className="flex flex-1 items-center gap-4 overflow-x-auto">
        <Metric
          label="CPU"
          percent={stats?.cpuPercent ?? null}
          detail={
            stats ? `${Math.round(stats.cpuPercent)}%` : error ? "—" : "…"
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
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {error
          ? "stats unavailable"
          : stats
            ? `updated ${new Date(stats.ts).toLocaleTimeString()}`
            : "loading…"}
      </span>
      <StatsHistoryChart />
    </header>
  );
}

function barColor(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

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
    <div className="flex min-w-[9rem] items-center gap-2">
      <span className="w-9 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${
            percent == null ? "bg-muted-foreground/30" : barColor(pct)
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap font-mono text-xs tabular-nums">
        {detail}
      </span>
    </div>
  );
}
