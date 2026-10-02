"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChartSpline } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import type { HistoryPoint, HistoryRange, StatsHistory } from "@/lib/stats-history";

// recharts is browser-only and trips server prerender, so the chart body is
// loaded client-side. A skeleton fills the space until it hydrates.
const StatsMetricChart = dynamic(() => import("./stats-metric-chart"), {
  ssr: false,
  loading: () => <div className="h-20 w-full animate-pulse rounded-md bg-muted/40" />,
});

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: "1d", label: "24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

// Re-fetch the history this often while the dialog is open, so the charts track
// live as new samples land (the cron sampler writes a point each minute).
const REFRESH_MS = 15_000;

export function StatsHistoryChart() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<HistoryRange>("1d");
  const [data, setData] = useState<StatsHistory | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    // Only show the "loading…" placeholder on the first fetch for a range; the
    // periodic refreshes update the charts in place without blanking them.
    let first = true;
    const load = async () => {
      if (first) {
        setLoading(true);
        setError(false);
      }
      try {
        const r = await fetch(`${BASE_PATH}/api/stats/history?range=${range}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(String(r.status));
        const d: StatsHistory = await r.json();
        if (active) {
          setData(d);
          setError(false);
        }
      } catch {
        if (active && first) setError(true);
      } finally {
        if (active) setLoading(false);
        first = false;
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [open, range]);

  const points = data?.points ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Server activity history"
        title="Server activity history"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <ChartSpline className="size-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Server activity</DialogTitle>
        </DialogHeader>

        <Tabs value={range} onValueChange={(v) => setRange(v as HistoryRange)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r.value} value={r.value}>
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {error ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            History unavailable.
          </p>
        ) : points.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {loading
              ? "Loading…"
              : "No history yet — samples are collected every minute."}
          </p>
        ) : (
          <div className="space-y-4">
            <Metric
              label="CPU"
              accent="#0ea5e9"
              range={range}
              points={points}
              value={(p) => p.cpu}
              detail={(p) => `${p.cpu.toFixed(0)}%`}
            />
            <Metric
              label="Memory"
              accent="#8b5cf6"
              range={range}
              points={points}
              value={(p) => p.mem}
              detail={(p) =>
                `${p.mem.toFixed(0)}% · ${formatBytes(p.memUsedBytes)} / ${formatBytes(p.memTotalBytes)}`
              }
            />
            <Metric
              label="Disk"
              accent="#f59e0b"
              range={range}
              points={points}
              value={(p) => p.disk}
              detail={(p) =>
                `${p.disk.toFixed(0)}% · ${formatBytes(p.diskUsedBytes)} / ${formatBytes(p.diskTotalBytes)}`
              }
            />
            <p className="text-right text-xs text-muted-foreground">
              {new Date(points[0].t).toLocaleString()} —{" "}
              {new Date(points[points.length - 1].t).toLocaleString()}
            </p>
          </div>
        )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Header row (current value + peak) above the dynamically-loaded area chart. */
function Metric({
  label,
  accent,
  range,
  points,
  value,
  detail,
}: {
  label: string;
  accent: string;
  range: HistoryRange;
  points: HistoryPoint[];
  value: (p: HistoryPoint) => number;
  detail: (p: HistoryPoint) => string;
}) {
  const last = points[points.length - 1];
  const peak = points.reduce((m, p) => (value(p) > value(m) ? p : m), points[0]);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          now {detail(last)} · peak {value(peak).toFixed(0)}%
        </span>
      </div>
      <StatsMetricChart
        label={label}
        accent={accent}
        range={range}
        points={points}
        value={value}
      />
    </div>
  );
}
