"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatBytes } from "@/lib/format";
import type { HistoryRange, ProjectMemoryPoint } from "@/lib/stats-history";

// (violet as the top bar's MEM; checked for colour-blind separation and contrast in light and dark)
const config = {
  bytes: { label: "Project", color: "#7c3aed" },
  agentBytes: { label: "Agents", color: "#d97706" },
} satisfies ChartConfig;

const tick = (range: HistoryRange) => (t: number) =>
  range === "1d"
    ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });

/**
 * A project's memory over time, its agents' (Claude sessions) as a second, lighter
 * area, and its limit as a dashed line. Loaded with next/dynamic({ ssr: false })
 * from ProjectMemoryPanel, like StatsMetricChart, so recharts never prerenders.
 */
export default function ProjectMemoryChart({
  range,
  points,
  limitBytes,
}: {
  range: HistoryRange;
  points: ProjectMemoryPoint[];
  limitBytes: number | null;
}) {
  const top = Math.max(
    limitBytes ?? 0,
    ...points.map((p) => Math.max(p.bytes, p.agentBytes)),
  );
  return (
    <div className="space-y-1">
      {/* (the legend: a swatch beside plain text, so the series isn't told by colour alone) */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        {(["bytes", "agentBytes"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span
              className="h-0.5 w-3 rounded-full"
              style={{ background: config[k].color }}
            />
            {config[k].label}
          </span>
        ))}
        {limitBytes != null && (
          <span className="flex items-center gap-1.5">
            <span className="w-3 border-t border-dashed border-muted-foreground" />
            Limit
          </span>
        )}
      </div>
      <ChartContainer config={config} className="aspect-auto h-48 w-full">
        <AreaChart
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            {(["bytes", "agentBytes"] as const).map((k) => (
              <linearGradient
                key={k}
                id={`pm-fill-${k}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={config[k].color}
                  stopOpacity={k === "bytes" ? 0.35 : 0.2}
                />
                <stop
                  offset="100%"
                  stopColor={config[k].color}
                  stopOpacity={0.02}
                />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tick(range)}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tick={{ fontSize: 10 }}
          />
          <YAxis
            domain={[0, top * 1.1 || 1]}
            width={56}
            tickFormatter={(v) => formatBytes(Number(v))}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10 }}
          />
          <ChartTooltip
            cursor={{ stroke: config.bytes.color, strokeOpacity: 0.4 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, payload) => {
                  const t = payload?.[0]?.payload?.t as number | undefined;
                  return t == null ? "" : new Date(t).toLocaleString();
                }}
                formatter={(v, name) => (
                  <span className="flex w-full justify-between gap-3">
                    <span className="text-muted-foreground">
                      {config[name as keyof typeof config]?.label ?? name}
                    </span>
                    <span className="font-mono tabular-nums">
                      {formatBytes(Number(v))}
                    </span>
                  </span>
                )}
              />
            }
          />
          {limitBytes != null && (
            <ReferenceLine
              y={limitBytes}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              label={{
                value: `limit ${formatBytes(limitBytes)}`,
                position: "insideTopRight",
                fontSize: 10,
                fill: "var(--muted-foreground)",
              }}
            />
          )}
          <Area
            dataKey="agentBytes"
            type="monotone"
            stroke={config.agentBytes.color}
            strokeWidth={2}
            fill="url(#pm-fill-agentBytes)"
            isAnimationActive={false}
          />
          <Area
            dataKey="bytes"
            type="monotone"
            stroke={config.bytes.color}
            strokeWidth={2}
            fill="url(#pm-fill-bytes)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
