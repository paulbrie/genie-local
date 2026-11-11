"use client";

import { Bot, MemoryStick } from "lucide-react";
import { useId, useState } from "react";
import { useSubject } from "subjecto/react";

import { Empty, ROW, useOpenPath, usePolled, useWidgetView, ViewSwitch, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";
import { type MemoryDistribution, projectTotals } from "@/lib/memory-history-core";
import { cn } from "@/lib/utils";
import { projectMemory } from "@/store/project-memory";
import { liveTerminals, openTerminal } from "@/store/terminals";

/** Distinct, steady colours for the memory's projects (a name's hue; the next free one when two would match). */
const PALETTE = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#f43f5e", "#14b8a6", "#6366f1", "#d946ef", "#84cc16", "#f97316"];

/** Each name's colour: its hash's, the next free one on a clash, the clashes settled in name order (so the same names get the same colours, whatever their order). */
function colorsFor(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  for (const n of [...names].sort()) {
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let i = h % PALETTE.length;
    for (let k = 0; k < PALETTE.length && used.has(i); k++) i = (i + 1) % PALETTE.length;
    used.add(i);
    out.set(n, PALETTE[i]);
  }
  return out;
}

const stripes = (c: string) => `repeating-linear-gradient(135deg, ${c} 0 2px, color-mix(in oklab, ${c} 35%, transparent) 2px 4px)`;
// (a legend's swatch for many: their colours round a little wheel)
const wheel = (cs: string[]) => (cs.length > 1 ? `conic-gradient(${cs.slice(0, 6).join(", ")}, ${cs[0]})` : (cs[0] ?? "#a1a1aa"));

const PERIODS = [
  { value: "now", label: "Now" },
  { value: "1d", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;
type Period = (typeof PERIODS)[number]["value"];
const SPAN_MS: Record<Exclude<Period, "now">, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

/**
 * Memory: now, the server's RAM as one bar in the way of macOS's storage bar (each project a segment in its colour, its
 * Claude agents striped after it, then the system, then what's free; by terminal with the switch), live from the top
 * bar's figures; or over the last 24 hours, 7 or 30 days (the default), a stacked area of the same (the history's
 * per-minute figures, /api/widgets/memory), a crosshair telling a moment's. Under either, a row a project; hovering a
 * row lights its part up, and the other way round. The period and the split are remembered.
 */
export function MemoryWidget({ folded }: { folded: boolean }) {
  const [status] = useSubject(projectMemory);
  const [period, setPeriod] = useWidgetView<Period>("memory", "period", PERIODS.map((p) => p.value), "30d");
  const [split, setSplit] = useWidgetView<"projects" | "terminals">("memory", "split", ["projects", "terminals"], "projects");
  const { data: hist, failed } = usePolled<MemoryDistribution & { range: string }>(period === "now" ? null : `/api/widgets/memory?range=${period}`, 5 * 60_000);
  // (what came for another period, while this one's on its way, isn't shown)
  const history = hist && hist.range === period ? hist : null;
  const [hot, setHot] = useState<string | null>(null);
  const total = status?.server.totalBytes ?? 0;
  const free = status?.server.availableBytes ?? 0;
  const used = Math.max(0, total - free);
  return (
    <>
      <WidgetHeader
        id="memory"
        icon={MemoryStick}
        title="Memory"
        count={status && total ? `${Math.round((used / total) * 100)}%` : null}
        note={status ? `${formatBytes(free)} free` : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          <div className="flex items-center gap-2 pr-2 pb-2 pl-7">
            <ViewSwitch label="Memory over" value={period} onChange={setPeriod} options={PERIODS} />
            <span className="ml-auto" />
            {period === "now" && (
              <ViewSwitch
                label="Show memory by"
                value={split}
                onChange={setSplit}
                options={[
                  { value: "projects", label: "Projects" },
                  { value: "terminals", label: "Terminals" },
                ]}
              />
            )}
          </div>
          {period === "now" ? (
            status ? (
              <NowView split={split} hot={hot} setHot={setHot} />
            ) : (
              <Empty>Loading…</Empty>
            )
          ) : history ? (
            <HistoryView history={history} span={SPAN_MS[period]} hot={hot} setHot={setHot} />
          ) : (
            <Empty>{failed ? "Couldn't read the history." : "Loading…"}</Empty>
          )}
        </WidgetList>
      )}
    </>
  );
}

type Hover = { hot: string | null; setHot: (k: string | null) => void };

/** A segment of the bar, or a row under it: its own part, and (projects) its Claude agents, drawn striped after it. */
type Share = { key: string; label: string; bytes: number; agents: number; color: string; open: () => void; title: string };

/** Now: the bar, the four totals, and a row a project (or a terminal). */
function NowView({ split, hot, setHot }: { split: "projects" | "terminals" } & Hover) {
  const [status] = useSubject(projectMemory);
  const [terms] = useSubject(liveTerminals);
  const openPath = useOpenPath();
  const view = split;
  const total = status?.server.totalBytes ?? 0;
  const free = status?.server.availableBytes ?? 0;
  const used = Math.max(0, total - free);
  const projs = (status?.projects ?? []).filter((p) => p.bytes > 0 || p.agentBytes > 0).sort((a, b) => b.bytes + b.agentBytes - (a.bytes + a.agentBytes));
  const projBytes = projs.reduce((n, p) => n + p.bytes, 0);
  const agentBytes = projs.reduce((n, p) => n + p.agentBytes, 0);
  const projColors = colorsFor(projs.map((p) => p.slug));
  const termList = terms.filter((t) => t.memBytes).sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0));
  const termColors = colorsFor(termList.map((t) => t.name));
  const pct = (b: number) => (total ? (b / total) * 100 : 0);

  const shares: Share[] =
    view === "projects"
      ? projs.map((p) => ({
          key: p.slug,
          label: p.slug,
          bytes: p.bytes,
          agents: p.agentBytes,
          color: projColors.get(p.slug)!,
          open: () => openPath(`/projects/${encodeURIComponent(p.slug)}/memory`),
          title: `${p.slug}: ${formatBytes(p.bytes)}${p.agentBytes ? ` + ${formatBytes(p.agentBytes)} in Claude agents` : ""} · ${pct(p.bytes + p.agentBytes).toFixed(1)}% of RAM`,
        }))
      : termList.map((t) => ({
          key: t.name,
          label: t.name,
          bytes: t.memBytes ?? 0,
          agents: 0,
          color: termColors.get(t.name)!,
          open: () => openTerminal(t.name),
          title: `${t.name}: ${formatBytes(t.memBytes ?? 0)} · ${pct(t.memBytes ?? 0).toFixed(1)}% of RAM`,
        }));
  const shown = shares.reduce((n, s) => n + s.bytes + s.agents, 0);
  // (terminals: their memory is their projects' too, so the rest is everything else that's in use)
  const rest = Math.max(0, used - shown);
  const top = Math.max(1, ...shares.map((s) => s.bytes + s.agents));
  const dim = (key: string) => hot !== null && hot !== key;
  return (
    <>
      <div className="flex flex-col gap-2 pr-2 pb-1.5 pl-7">
              {/* (the headline: how much is in use, of how much) */}
              <div className="flex items-end gap-2">
                <span className="text-xl leading-none font-semibold tracking-tight tabular-nums">{formatBytes(used)}</span>
                <span className="pb-px text-[11px] leading-none text-muted-foreground">used of {formatBytes(total)}</span>
              </div>
              {/* the bar: every share, then the rest in use, then (the track) what's free */}
              <TooltipProvider delay={80} closeDelay={40}>
                <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-foreground/[0.07] shadow-inner" onPointerLeave={() => setHot(null)}>
                  {shares.map((s) => (
                    <Tooltip key={s.key}>
                      <TooltipTrigger
                        render={<div />}
                        onPointerEnter={() => setHot(s.key)}
                        className="flex h-full shrink-0 gap-[1px] transition-opacity duration-150"
                        style={{ width: `${pct(s.bytes + s.agents)}%`, minWidth: 3, opacity: dim(s.key) ? 0.3 : 1 }}
                      >
                        <div className="h-full" style={{ flex: s.bytes || 0.0001, background: s.color }} />
                        {s.agents > 0 && <div className="h-full" style={{ flex: s.agents, background: stripes(s.color) }} />}
                      </TooltipTrigger>
                      <TooltipContent side="top">{s.title}</TooltipContent>
                    </Tooltip>
                  ))}
                  {rest > 0 && (
                    <Tooltip>
                      <TooltipTrigger
                        render={<div />}
                        onPointerEnter={() => setHot("rest")}
                        className="h-full shrink-0 bg-foreground/30 transition-opacity duration-150"
                        style={{ width: `${pct(rest)}%`, opacity: dim("rest") ? 0.3 : 1 }}
                      />
                      <TooltipContent side="top">
                        {view === "projects" ? "System and everything else" : "Everything else in use"}: {formatBytes(rest)}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TooltipProvider>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {(view === "projects"
                  ? [
                      { label: "Projects", bytes: projBytes, swatch: <span className="size-2 rounded-full" style={{ background: wheel(shares.map((x) => x.color)) }} /> },
                      { label: "Agents", bytes: agentBytes, swatch: <span className="size-2 rounded-full" style={{ background: stripes("#a1a1aa") }} /> },
                      { label: "System", bytes: rest, swatch: <span className="size-2 rounded-full bg-foreground/30" /> },
                      { label: "Free", bytes: free, swatch: <span className="size-2 rounded-full bg-foreground/[0.07] ring-1 ring-foreground/15" /> },
                    ]
                  : [
                      { label: "Terminals", bytes: shown, swatch: <span className="size-2 rounded-full" style={{ background: wheel(shares.map((x) => x.color)) }} /> },
                      { label: "Other", bytes: rest, swatch: <span className="size-2 rounded-full bg-foreground/30" /> },
                      { label: "Free", bytes: free, swatch: <span className="size-2 rounded-full bg-foreground/[0.07] ring-1 ring-foreground/15" /> },
                    ]
                ).map((x) => (
                  <span key={x.label} className="flex items-center gap-1.5">
                    {x.swatch}
                    {x.label}
                    <span className="ml-auto font-mono tabular-nums text-foreground/80">{formatBytes(x.bytes)}</span>
                  </span>
                ))}
              </div>
            </div>
      {status && !shares.length && <Empty>{view === "projects" ? "Nothing running in a project." : "No terminal's memory known yet."}</Empty>}
          {shares.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={s.open}
              onPointerEnter={() => setHot(s.key)}
              onPointerLeave={() => setHot(null)}
              title={s.title}
              className={cn(ROW, "relative isolate overflow-hidden", hot === s.key && "text-foreground")}
            >
              {/* (its share, drawn behind it in its colour) */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 -z-10 rounded-md transition-[width,opacity] duration-300"
                style={{ width: `${((s.bytes + s.agents) / top) * 100}%`, background: s.color, opacity: hot === s.key ? 0.22 : 0.1 }}
              />
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{s.bytes ? formatBytes(s.bytes) : "—"}</span>
              {s.agents > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums opacity-60" title="Claude sessions working in it">
                  <Bot className="size-2.5" />
                  {formatBytes(s.agents)}
                </span>
              )}
            </button>
          ))}
    </>
  );
}

/**
 * Over a period: how much was used on average and at the peak, the stacked area (the five biggest projects in their
 * colours, the others together, the Claude agents striped, then the system; the top of the box all the RAM), a
 * crosshair telling a moment's figures, and a row a project with its average and its peak.
 */
function HistoryView({ history, span, hot, setHot }: { history: MemoryDistribution; span: number } & Hover) {
  const openPath = useOpenPath();
  const pid = useId().replace(/:/g, "");
  const [at, setAt] = useState<number | null>(null);
  const points = history.points;
  if (!points.length) return <Empty>No memory recorded in this period yet.</Empty>;

  const totals = projectTotals(points);
  const colors = colorsFor(totals.map((t) => t.slug));
  const big = totals.slice(0, 5).map((t) => t.slug);
  const now = points[points.length - 1].t;
  // (the chart starts where the figures do: projects have been recorded for less than the period, at first)
  const start = Math.max(now - span, points[0].t);
  const shownSpan = Math.max(1, now - start);
  const since = start > now - span * 0.97;
  const max = history.totalBytes || Math.max(...points.map((p) => p.used));
  type Layer = { key: string; label: string; color: string; fill: string; values: number[] };
  const own = (p: (typeof points)[number], slug: string) => p.projects[slug] ?? 0;
  const layers: Layer[] = [
    ...big.map((slug) => ({ key: slug, label: slug, color: colors.get(slug)!, fill: colors.get(slug)!, values: points.map((p) => own(p, slug)) })),
    {
      key: "others",
      label: "Other projects",
      color: "#94a3b8",
      fill: "#94a3b8",
      values: points.map((p) => Object.entries(p.projects).reduce((n, [slug, b]) => n + (big.includes(slug) ? 0 : b), 0)),
    },
    { key: "agents", label: "Claude agents", color: "#8b5cf6", fill: `url(#${pid}-agents)`, values: points.map((p) => Object.values(p.agents).reduce((n, b) => n + b, 0)) },
    {
      key: "system",
      label: "System",
      color: "#a1a1aa",
      fill: "#a1a1aa",
      values: points.map((p) => Math.max(0, p.used - Object.values(p.projects).reduce((n, b) => n + b, 0) - Object.values(p.agents).reduce((n, b) => n + b, 0))),
    },
  ].filter((l) => l.values.some((v) => v > 0));

  const W = 300;
  const H = 100;
  const x = (t: number) => ((t - start) / shownSpan) * W;
  const y = (v: number) => H - (Math.min(v, max) / max) * H;
  // (each layer between the ones under it and itself)
  const under = layers.map((_, i) => points.map((_, k) => layers.slice(0, i).reduce((n, l) => n + l.values[k], 0)));
  const shape = (i: number) => {
    const top = points.map((p, k) => `${x(p.t).toFixed(1)},${y(under[i][k] + layers[i].values[k]).toFixed(1)}`);
    const base = points.map((p, k) => `${x(p.t).toFixed(1)},${y(under[i][k]).toFixed(1)}`).reverse();
    return [...top, ...base].join(" ");
  };
  const avgUsed = points.reduce((n, p) => n + p.used, 0) / points.length;
  const peakUsed = Math.max(...points.map((p) => p.used));
  const topAvg = Math.max(1, ...totals.map((t) => t.avg + t.agentsAvg));
  const when = (t: number) =>
    new Date(t).toLocaleString(undefined, span > 86_400_000 ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const moment = at === null ? null : points[at];

  return (
    <>
      <div className="flex flex-col gap-1.5 pr-2 pb-1.5 pl-7">
        <div className="flex items-end gap-2">
          <span className="shrink-0 text-xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums">{formatBytes(avgUsed)}</span>
          <span className="min-w-0 truncate pb-px text-[11px] leading-none text-muted-foreground">
            on average · peak {formatBytes(peakUsed)} of {formatBytes(max)}
          </span>
        </div>
        {/* the chart: a moment under the pointer gets a line and its figures */}
        <div
          className="relative h-28 w-full"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const t = start + ((e.clientX - r.left) / r.width) * shownSpan;
            let best = 0;
            for (let k = 1; k < points.length; k++) if (Math.abs(points[k].t - t) < Math.abs(points[best].t - t)) best = k;
            setAt(best);
          }}
          onPointerLeave={() => setAt(null)}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible rounded-md bg-foreground/[0.04]" aria-hidden>
            <defs>
              <pattern id={`${pid}-agents`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="4" fill="#8b5cf6" opacity="0.25" />
                <rect width="2" height="4" fill="#8b5cf6" opacity="0.75" />
              </pattern>
            </defs>
            {layers.map((l, i) => (
              <polygon
                key={l.key}
                points={shape(i)}
                fill={l.fill}
                className="transition-opacity duration-150"
                opacity={hot && hot !== l.key ? 0.18 : l.key === "system" || l.key === "others" ? 0.45 : 0.85}
              />
            ))}
            <polyline points={points.map((p) => `${x(p.t).toFixed(1)},${y(p.used).toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" className="text-foreground/50" />
          </svg>
          {moment && at !== null && (
            <>
              <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${(x(moment.t) / W) * 100}%` }} />
              <div
                className="pointer-events-none absolute top-1 z-10 w-40 rounded-md bg-foreground px-2 py-1.5 text-[10px] text-background shadow-lg"
                style={x(moment.t) / W > 0.5 ? { right: `${100 - (x(moment.t) / W) * 100 + 2}%` } : { left: `${(x(moment.t) / W) * 100 + 2}%` }}
              >
                <p className="mb-0.5 font-medium">{when(moment.t)}</p>
                <p className="flex justify-between">
                  <span className="opacity-70">Used</span>
                  <span className="font-mono tabular-nums">{formatBytes(moment.used)}</span>
                </p>
                {layers
                  .filter((l) => l.values[at] > 0)
                  .map((l) => (
                    <p key={l.key} className="flex items-center gap-1">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: l.key === "agents" ? stripes(l.color) : l.color }} />
                      <span className="min-w-0 truncate opacity-80">{l.label}</span>
                      <span className="ml-auto font-mono tabular-nums">{formatBytes(l.values[at])}</span>
                    </p>
                  ))}
              </div>
            </>
          )}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground/70">
          <span>
            {since
              ? `since ${new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : span >= 86_400_000 * 2
                ? `${Math.round(span / 86_400_000)} days ago`
                : "24 h ago"}
          </span>
          <span>now</span>
        </div>
      </div>
      {totals.map((t) => (
        <button
          key={t.slug}
          type="button"
          onClick={() => openPath(`/projects/${encodeURIComponent(t.slug)}/memory`)}
          onPointerEnter={() => setHot(big.includes(t.slug) ? t.slug : "others")}
          onPointerLeave={() => setHot(null)}
          title={`${t.slug}: ${formatBytes(t.avg)} on average${t.agentsAvg ? ` (+ ${formatBytes(t.agentsAvg)} in Claude agents)` : ""}, ${formatBytes(t.peak)} at the peak`}
          className={cn(ROW, "relative isolate overflow-hidden", hot === t.slug && "text-foreground")}
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 -z-10 rounded-md transition-[width,opacity] duration-300"
            style={{ width: `${((t.avg + t.agentsAvg) / topAvg) * 100}%`, background: colors.get(t.slug), opacity: hot === t.slug ? 0.22 : 0.1 }}
          />
          <span className="size-2 shrink-0 rounded-full" style={{ background: big.includes(t.slug) ? colors.get(t.slug) : "#94a3b8" }} />
          <span className="min-w-0 truncate">{t.slug}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{formatBytes(t.avg)}</span>
          <span className="w-14 shrink-0 text-right font-mono text-[9px] tabular-nums opacity-55">↑{formatBytes(t.peak)}</span>
        </button>
      ))}
    </>
  );
}
