"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { HistoryPoint, HistoryRange } from "@/lib/stats-history";

/** Time-axis tick formatter: clock time for 24h, day/month for longer ranges. */
function tickFmt(range: HistoryRange) {
  return (t: number) =>
    range === "1d"
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * One metric as a shadcn/recharts filled area chart over a 0–100% axis. Loaded
 * via `next/dynamic({ ssr: false })` from {@link StatsHistoryChart}, so recharts
 * never runs during server prerender.
 */
export default function StatsMetricChart({
  label,
  accent,
  range,
  points,
  value,
}: {
  label: string;
  accent: string;
  range: HistoryRange;
  points: HistoryPoint[];
  value: (p: HistoryPoint) => number;
}) {
  const chartData = points.map((p) => ({ t: p.t, v: value(p) }));
  const config = { v: { label, color: accent } } satisfies ChartConfig;
  const fmtTick = tickFmt(range);

  return (
    <ChartContainer config={config} className="aspect-auto h-20 w-full">
      <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`fill-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={fmtTick}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
          tick={{ fontSize: 10 }}
        />
        <YAxis
          domain={[0, 100]}
          width={28}
          ticks={[0, 50, 100]}
          tickFormatter={(v) => `${v}`}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10 }}
        />
        <ChartTooltip
          cursor={{ stroke: accent, strokeOpacity: 0.4 }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => {
                const t = payload?.[0]?.payload?.t as number | undefined;
                return t == null ? "" : new Date(t).toLocaleString();
              }}
              formatter={(v) => `${Number(v).toFixed(0)}%`}
            />
          }
        />
        <Area
          dataKey="v"
          type="monotone"
          stroke={accent}
          strokeWidth={1.5}
          fill={`url(#fill-${label})`}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
