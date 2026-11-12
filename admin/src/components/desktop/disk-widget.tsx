"use client";

import { ChartBarStacked, ChartPie, ChevronRight, HardDrive, LayoutDashboard, List, Loader2, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ago, Empty, Meter, usePolled, useWidgetView, ViewSwitch, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { BASE_PATH } from "@/lib/config";
import type { DiskDir, DiskEntry, DiskOverview, DiskPart } from "@/lib/disk-overview-core";
import { formatBytes } from "@/lib/format";
import { squarify } from "@/lib/treemap";
import { cn } from "@/lib/utils";

/** Each part's colour: the folders, Docker, and the rest (grey); the home folder (its path differs per box) violet. */
const COLORS: Record<string, string> = {
  "/opt/project": "#0ea5e9",
  "/tmp": "#f59e0b",
  "/usr": "#14b8a6",
  "/var": "#f43f5e",
  docker: "#6366f1",
  other: "#a1a1aa",
};
const colorOf = (key: string) => COLORS[key] ?? "#8b5cf6";

const VIEWS = [
  { value: "list", label: "List", icon: List },
  { value: "bar", label: "Bar", icon: ChartBarStacked },
  { value: "donut", label: "Donut", icon: ChartPie },
  { value: "treemap", label: "Treemap", icon: LayoutDashboard },
] as const;
type View = (typeof VIEWS)[number]["value"];

/**
 * The disk: how much of it is used, and by what: /opt/project, /tmp, the home folder, /usr, /var, Docker, and the
 * rest (Other) (/api/disk: measured in the background, at most every 10 minutes, or now with the refresh button).
 * Shown as a list with each part's largest entries, one segmented bar, a donut, or a treemap of the parts and what's
 * in them (the switch, remembered). In the bar and the donut, a part and its row light each other up. In every view, a
 * click on a folder drills into it (its own entries and theirs, /api/disk/dir), a breadcrumb leading back up; switching
 * views stays in the folder.
 */
export function DiskWidget({ folded }: { folded: boolean }) {
  const { data, failed, reload } = usePolled<DiskOverview>("/api/disk", 60_000, (d) => (d.scanning ? 4000 : null));
  const [view, setView] = useWidgetView<View>("disk", "chart", VIEWS.map((v) => v.value), "list");
  const [hot, setHot] = useState<string | null>(null);
  // (the folder drilled into; null: the whole disk)
  const [trail, setTrail] = useState<string | null>(null);
  const { data: dirData, failed: dirFailed } = usePolled<DiskDir & { asked: string }>(
    trail ? `/api/disk/dir?path=${encodeURIComponent(trail)}` : null,
    5 * 60_000,
  );
  const drilled = dirData && dirData.asked === trail ? dirData : null;
  const drill = (path: string | null) => {
    setHot(null);
    setTrail(path);
  };

  const disk = data?.fs[0];
  const pct = disk && disk.size ? Math.round((disk.used / disk.size) * 100) : null;
  const parts = data?.parts?.filter((p) => p.bytes > 0) ?? null;
  const again = async () => {
    await fetch(`${BASE_PATH}/api/disk?fresh=1`, { cache: "no-store" }).catch(() => {});
    reload();
  };

  // What's drawn: the parts of the disk, or the folder drilled into (while the next one's measured, the one before
  // stays, dimmed); and what their shares are of: the disk (what's free its track), or the folder.
  const shown = drilled ?? (trail ? (dirData ?? null) : null);
  const loading = !!trail && !drilled && !dirFailed;
  const blocks = shown ? dirBlocks(shown) : parts ? partBlocks(parts) : [];
  const of: Scale | null = shown ? { total: shown.bytes, free: null, label: shown.path.split("/").pop() || shown.path } : disk ? { total: disk.size, free: disk.avail, label: "the disk" } : null;
  const onDrill = loading ? undefined : drill;

  return (
    <>
      <WidgetHeader
        id="disk"
        icon={HardDrive}
        title="Disk"
        count={pct === null ? null : `${pct}%`}
        note={disk ? `${formatBytes(disk.avail)} free` : failed ? "couldn't read" : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the disk." : "Loading…"}</Empty>}
          {disk && (
            <div className="flex items-end gap-2 pr-2 pb-2 pl-7">
              <span className="shrink-0 text-xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums">{formatBytes(disk.used)}</span>
              <span className="min-w-0 truncate pb-px text-[11px] leading-none text-muted-foreground">used of {formatBytes(disk.size)}</span>
              <span className="ml-auto" />
              <ViewSwitch label="Show the disk as" value={view} onChange={setView} options={VIEWS} />
            </div>
          )}
          {data && !parts && <Empty>Measuring the folders (a minute the first time)…</Empty>}
          {disk && parts && of && (
            // (the treemap's column fills the widget, taking all the room left; the others are as tall as they are)
            <div className={cn("flex flex-col pr-2 pl-7", view === "treemap" && "min-h-44 flex-1")}>
              {trail && <Crumbs parts={parts} trail={trail} bytes={drilled?.bytes ?? null} onDrill={drill} />}
              {dirFailed && trail && !drilled ? (
                <p className="py-2 text-xs text-muted-foreground">Couldn&apos;t measure that folder.</p>
              ) : drilled && !drilled.entries.length ? (
                <p className="py-2 text-xs text-muted-foreground">Nothing in it takes room.</p>
              ) : (
                <div className={cn("relative flex flex-col", view === "treemap" && "min-h-0 flex-1")}>
                  <div className={cn("flex flex-col transition-opacity", view === "treemap" && "min-h-0 flex-1", loading && "opacity-35")}>
                    {view === "list" && <ListView blocks={blocks} of={of} onDrill={onDrill} />}
                    {view === "bar" && <BarView blocks={blocks} of={of} hot={hot} setHot={setHot} onDrill={onDrill} />}
                    {view === "donut" && <DonutView blocks={blocks} of={of} hot={hot} setHot={setHot} onDrill={onDrill} />}
                    {view === "treemap" && <TreemapView blocks={blocks} onDrill={onDrill} />}
                    {(view === "bar" || view === "donut") && <PartRows blocks={blocks} of={of} hot={hot} setHot={setHot} onDrill={onDrill} />}
                  </div>
                  {loading && (
                    <span className="absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> Measuring {trail?.split("/").pop()}…
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {data && (
            <div className="mt-auto flex items-center gap-1.5 pt-1.5 pr-1 pl-7 text-[11px] text-muted-foreground">
              {data.scanning ? (
                <>
                  <Loader2 className="size-3 animate-spin" /> Measuring…
                </>
              ) : (
                <span>{drilled ? `Measured ${ago(drilled.measuredAt)}` : data.scannedAt ? `Measured ${ago(data.scannedAt)}` : ""}</span>
              )}
              <button
                type="button"
                onClick={again}
                disabled={data.scanning}
                aria-label="Measure again"
                title="Measure again"
                className="ml-auto rounded-md p-0.5 hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
              >
                <RotateCw className="size-3" />
              </button>
            </div>
          )}
        </WidgetList>
      )}
    </>
  );
}

/**
 * What a view draws: a part of the disk, or an entry of a folder drilled into, its colour, and `path` when it's a folder
 * (a click drills into it). `top`: its own largest entries.
 */
type Block = { key: string; label: string; bytes: number; top: DiskEntry[]; color: string; path: string | null; mono: boolean };

/** What the shares are of: the disk (what's free shown as the track), or the folder drilled into. */
type Scale = { total: number; free: number | null; label: string };

/** Colours for a drilled folder's entries, one each, in order of size. */
const DRILL_COLORS = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#f43f5e", "#14b8a6", "#6366f1", "#d946ef", "#84cc16", "#f97316"];

const partBlocks = (parts: DiskPart[]): Block[] =>
  parts.map((p) => ({
    key: p.key,
    label: p.label,
    bytes: p.bytes,
    top: p.top,
    color: colorOf(p.key),
    path: p.key.startsWith("/") ? p.key : null,
    // (a part named by its path)
    mono: p.key.startsWith("/") || p.label.startsWith("~"),
  }));

const dirBlocks = (d: DiskDir): Block[] =>
  d.entries.map((e, i) => {
    const full = d.path === "/" ? `/${e.name}` : `${d.path}/${e.name}`;
    return { key: full, label: e.name, bytes: e.bytes, top: e.top, color: DRILL_COLORS[i % DRILL_COLORS.length], path: e.dir ? full : null, mono: false };
  });

/** What makes something drill into `path` on a click (or Enter): nothing when it isn't a folder, or while one's measured. */
function drillable(path: string | null, onDrill: ((path: string) => void) | undefined) {
  if (!path || !onDrill) return {};
  return {
    role: "button",
    tabIndex: 0,
    onClick: () => onDrill(path),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onDrill(path);
      }
    },
  } as const;
}

const pctOf = (bytes: number, of: Scale) => `${((bytes / Math.max(1, of.total)) * 100).toFixed(1)}% of ${of.label}`;

/**
 * Where the views are: Disk, then the part the folder is in, then each folder down to it, each a way back up; the
 * folder's size at the end.
 */
function Crumbs({ parts, trail, bytes, onDrill }: { parts: DiskPart[]; trail: string; bytes: number | null; onDrill: (path: string | null) => void }) {
  // (the part it's in, the start of the trail; then each folder down from there)
  const base = parts.filter((p) => p.key.startsWith("/") && (trail === p.key || trail.startsWith(`${p.key}/`))).sort((a, b) => b.key.length - a.key.length)[0];
  const crumbs = base ? [{ label: base.label, path: base.key }, ...trail.slice(base.key.length + 1).split("/").filter(Boolean).map((seg, i, all) => ({ label: seg, path: `${base.key}/${all.slice(0, i + 1).join("/")}` }))] : [];
  return (
    <nav aria-label="Which folder the disk is shown in" className="mb-1.5 flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground">
      <button type="button" onClick={() => onDrill(null)} className="shrink-0 rounded px-1 hover:bg-foreground/10 hover:text-foreground">
        Disk
      </button>
      {crumbs.map((c, i) => (
        <span key={c.path} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3 shrink-0 opacity-50" />
          <button
            type="button"
            onClick={() => onDrill(c.path)}
            aria-current={i === crumbs.length - 1 ? "page" : undefined}
            className={cn("min-w-0 truncate rounded px-1 hover:bg-foreground/10 hover:text-foreground", i === crumbs.length - 1 && "font-medium text-foreground")}
          >
            {c.label}
          </button>
        </span>
      ))}
      {bytes != null && <span className="ml-auto shrink-0 pl-2 tabular-nums">{formatBytes(bytes)}</span>}
    </nav>
  );
}

/**
 * The list: each part (or entry of the folder drilled into), its share, and its largest entries (on the whole disk,
 * /opt/project and /tmp their five, the rest three). A folder's row drills into it, as does an entry that's a folder.
 */
function ListView({ blocks, of, onDrill }: { blocks: Block[]; of: Scale; onDrill?: (path: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((b) => (
        <div key={b.key} className="flex flex-col gap-0.5">
          <div
            {...drillable(b.path, onDrill)}
            title={`${b.label}: ${formatBytes(b.bytes)} · ${pctOf(b.bytes, of)}${b.path && onDrill ? " · click to open" : ""}`}
            className={cn("-mx-1 flex flex-col gap-0.5 rounded-md px-1 py-0.5", b.path && onDrill && "cursor-pointer outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring")}
          >
            <div className="flex items-baseline gap-2 text-xs">
              <span className="size-2 shrink-0 self-center rounded-full" style={{ background: b.color }} />
              <span className={cn("truncate font-medium", b.mono && "font-mono")}>{b.label}</span>
              {b.path && onDrill && <ChevronRight className="size-3 shrink-0 self-center opacity-40" />}
              <span className="ml-auto shrink-0 tabular-nums">{formatBytes(b.bytes)}</span>
            </div>
            <Meter value={of.total ? b.bytes / of.total : 0} thin />
          </div>
          {b.top.slice(0, b.key === "/opt/project" || b.key === "/tmp" ? 5 : 3).map((e) => {
            const path = e.dir && b.path ? `${b.path}/${e.name}` : null;
            return (
              <div
                key={e.name}
                {...drillable(path, onDrill)}
                className={cn(
                  "-mx-1 flex items-baseline gap-2 rounded px-1 pl-5 text-[11px] text-muted-foreground",
                  path && onDrill && "cursor-pointer outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                )}
                title={`${b.label}/${e.name}: ${formatBytes(e.bytes)}${path && onDrill ? " · click to open" : ""}`}
              >
                <span className="min-w-0 truncate">{e.name}</span>
                <span className="ml-auto shrink-0 tabular-nums opacity-80">{formatBytes(e.bytes)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type Hover = { hot: string | null; setHot: (k: string | null) => void; onDrill?: (path: string) => void };

/**
 * One segmented bar: every part (or entry) in its colour, then (the track) what's free on the disk, or the rest of the
 * folder; a segment's tooltip says what it is, and a folder's drills into it.
 */
function BarView({ blocks, of, hot, setHot, onDrill }: { blocks: Block[]; of: Scale } & Hover) {
  return (
    <TooltipProvider delay={80} closeDelay={40}>
      <div className="mb-2 flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-foreground/[0.07] shadow-inner" onPointerLeave={() => setHot(null)}>
        {blocks.map((b) => (
          <Tooltip key={b.key}>
            <TooltipTrigger
              render={<div />}
              {...drillable(b.path, onDrill)}
              onPointerEnter={() => setHot(b.key)}
              className={cn("h-full shrink-0 transition-opacity duration-150", b.path && onDrill && "cursor-pointer")}
              style={{ width: `${(b.bytes / Math.max(1, of.total)) * 100}%`, minWidth: 3, background: b.color, opacity: hot && hot !== b.key ? 0.3 : 1 }}
            />
            <TooltipContent side="top">
              {b.label}: {formatBytes(b.bytes)} · {pctOf(b.bytes, of)}
              {b.path && onDrill ? " · click to open" : ""}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {of.free != null && <p className="sr-only">{formatBytes(of.free)} free</p>}
    </TooltipProvider>
  );
}

/**
 * A donut: every part (or entry) an arc in its colour round the disk (or the folder), what's free (or the rest) the
 * bare track; in the middle, the disk's used % or the folder's size. A folder's arc drills into it.
 */
function DonutView({ blocks, of, hot, setHot, onDrill }: { blocks: Block[]; of: Scale } & Hover) {
  const R = 40;
  const C = 2 * Math.PI * R;
  const GAP = 1.2;
  const total = Math.max(1, of.total);
  // (each arc starts where the ones before it end)
  const lens = blocks.map((b) => (b.bytes / total) * C);
  const arcs = blocks.map((b, i) => ({ b, len: Math.max(0.5, lens[i] - GAP), from: lens.slice(0, i).reduce((n, l) => n + l, 0) }));
  return (
    <TooltipProvider delay={80} closeDelay={40}>
      <div className="mb-2 flex justify-center">
        <svg viewBox="0 0 100 100" className="size-32 -rotate-90" onPointerLeave={() => setHot(null)} aria-hidden>
          <circle cx="50" cy="50" r={R} fill="none" strokeWidth="11" className="stroke-foreground/[0.07]" />
          {arcs.map(({ b, len, from }) => (
            <Tooltip key={b.key}>
              <TooltipTrigger
                {...drillable(b.path, onDrill)}
                onPointerEnter={() => setHot(b.key)}
                render={
                  <circle
                    cx="50"
                    cy="50"
                    r={R}
                    fill="none"
                    strokeWidth={hot === b.key ? 13 : 11}
                    stroke={b.color}
                    strokeDasharray={`${len} ${C - len}`}
                    strokeDashoffset={-from}
                    className={cn("transition-[stroke-width,opacity] duration-150 outline-none", b.path && onDrill ? "cursor-pointer" : "cursor-default")}
                    style={{ opacity: hot && hot !== b.key ? 0.3 : 1 }}
                  />
                }
              />
              <TooltipContent side="top">
                {b.label}: {formatBytes(b.bytes)} · {pctOf(b.bytes, of)}
                {b.path && onDrill ? " · click to open" : ""}
              </TooltipContent>
            </Tooltip>
          ))}
          <g className="rotate-90" style={{ transformOrigin: "50px 50px" }}>
            {of.free != null ? (
              <>
                <text x="50" y="49" textAnchor="middle" className="fill-foreground text-[15px] font-semibold tabular-nums">
                  {Math.round(((of.total - of.free) / total) * 100)}%
                </text>
                <text x="50" y="61" textAnchor="middle" className="fill-muted-foreground text-[7px]">
                  {formatBytes(of.free)} free
                </text>
              </>
            ) : (
              <>
                <text x="50" y="49" textAnchor="middle" className="fill-foreground text-[12px] font-semibold tabular-nums">
                  {formatBytes(of.total)}
                </text>
                <text x="50" y="60" textAnchor="middle" className="fill-muted-foreground text-[7px]">
                  in {of.label.length > 16 ? `${of.label.slice(0, 15)}…` : of.label}
                </text>
              </>
            )}
          </g>
        </svg>
      </div>
    </TooltipProvider>
  );
}

/**
 * Under the bar and the donut: each part (or entry) with its share drawn behind it, lighting its segment up (and the
 * other way round); a folder's row drills into it.
 */
function PartRows({ blocks, of, hot, setHot, onDrill }: { blocks: Block[]; of: Scale } & Hover) {
  const top = Math.max(1, ...blocks.map((b) => b.bytes));
  return (
    <div className="flex flex-col gap-px">
      {blocks.map((b) => (
        <div
          key={b.key}
          {...drillable(b.path, onDrill)}
          onPointerEnter={() => setHot(b.key)}
          onPointerLeave={() => setHot(null)}
          title={`${b.label}: ${formatBytes(b.bytes)} · ${pctOf(b.bytes, of)}${b.top.length ? ` · ${b.top.slice(0, 3).map((t) => `${t.name} ${formatBytes(t.bytes)}`).join(", ")}` : ""}${b.path && onDrill ? " · click to open" : ""}`}
          className={cn(
            "relative isolate flex items-center gap-2 overflow-hidden rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
            hot === b.key && "text-foreground",
            b.path && onDrill && "cursor-pointer",
          )}
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 -z-10 rounded-md transition-[width,opacity] duration-300"
            style={{ width: `${(b.bytes / top) * 100}%`, background: b.color, opacity: hot === b.key ? 0.22 : 0.1 }}
          />
          <span className="size-2 shrink-0 rounded-full" style={{ background: b.color }} />
          <span className={cn("min-w-0 truncate", b.mono && "font-mono")}>{b.label}</span>
          {b.path && onDrill && <ChevronRight className="size-3 shrink-0 opacity-40" />}
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{formatBytes(b.bytes)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A treemap of what's used: each block in its colour, split into its largest entries (and what else is in it), each
 * tile's area its size; the name and size written in where they fit, the tooltip says it all. A click opens what a
 * tile is named for: the block's first tile carries the block's name, so it opens the block; the others, the entry
 * they are when it's a folder (a block's "what else is in it", the block).
 */
function TreemapView({ blocks: items, onDrill }: { blocks: Block[]; onDrill?: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // (it fills the room the widget has: measured, so the tiles are laid out for its real shape)
  const [{ w, h: H }, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const blocks = squarify(
    items.map((p) => ({ key: p.key, value: p.bytes })),
    0,
    0,
    w,
    H,
  );
  const PAD = 1.5;
  return (
    <TooltipProvider delay={80} closeDelay={40}>
      <div ref={box} className="relative mb-1 min-h-40 w-full flex-1 overflow-hidden rounded-lg">
        {w > 0 &&
          blocks.map((b) => {
            const p = items.find((x) => x.key === b.key)!;
            const color = p.color;
            // (its entries, and what else is in it, tile the block; one with none is one tile)
            const rest = p.bytes - p.top.reduce((n, t) => n + t.bytes, 0);
            const kids = [...p.top.map((t) => ({ key: t.name, value: t.bytes })), ...(rest > 0 && p.top.length ? [{ key: "\u0000rest", value: rest }] : [])];
            const tiles = kids.length ? squarify(kids, b.x, b.y, b.w, b.h) : [{ key: p.label, x: b.x, y: b.y, w: b.w, h: b.h }];
            return tiles.map((t, i) => {
              const isRest = t.key === "\u0000rest";
              const entry = kids.length && !isRest ? p.top.find((e) => e.name === t.key) : undefined;
              const name = isRest ? `other in ${p.label}` : kids.length ? t.key : p.label;
              const bytes = kids.length ? kids.find((k) => k.key === t.key)!.value : p.bytes;
              // (where a click goes: the block from its first tile, which is named for it; else the entry when it's a
              // folder, the block for what else is in it)
              const opensBlock = i === 0 || !entry;
              const target = !onDrill || !p.path ? null : opensBlock ? p.path : entry.dir ? `${p.path}/${entry.name}` : null;
              const tw = t.w - PAD * 2;
              const th = t.h - PAD * 2;
              return (
                <Tooltip key={`${p.key}:${t.key}`}>
                  <TooltipTrigger
                    render={<div />}
                    onClick={target ? () => onDrill!(target) : undefined}
                    className={cn(
                      "absolute flex flex-col overflow-hidden rounded-[5px] p-1 leading-tight text-white transition-[filter]",
                      target ? "cursor-pointer hover:brightness-115" : "hover:brightness-105",
                    )}
                    style={{
                      left: t.x + PAD,
                      top: t.y + PAD,
                      width: Math.max(0, tw),
                      height: Math.max(0, th),
                      background: color,
                      // (the block's entries in its colour, the bigger ones the deeper; what else is in it the palest)
                      opacity: isRest ? 0.45 : Math.max(0.55, 1 - i * 0.09),
                    }}
                  >
                    {tw > 44 && th > 24 && (
                      <>
                        <span className="truncate text-[10px] font-medium">{i === 0 ? p.label : name}</span>
                        {th > 36 && <span className="truncate text-[9px] tabular-nums opacity-85">{i === 0 && kids.length ? `${name} ${formatBytes(bytes)}` : formatBytes(bytes)}</span>}
                      </>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {i === 0 && kids.length
                      ? `${p.label}: ${formatBytes(p.bytes)} (the most: ${name}, ${formatBytes(bytes)})`
                      : `${p.label}${kids.length ? ` › ${name}` : ""}: ${formatBytes(bytes)}`}
                    {target ? ` · click to open ${target === p.path ? p.label : name}` : ""}
                  </TooltipContent>
                </Tooltip>
              );
            });
          })}
      </div>
    </TooltipProvider>
  );
}
