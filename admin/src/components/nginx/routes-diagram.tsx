"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { hostsOf, listenOf, listenerName, localPortOf, upstreamText, type RouteRow } from "./route-rows";

const ROW = 30, GAP = 8, STEP = ROW + GAP, PAD = 12;
// the columns: x and width (in the SVG's own units; it scales to the box)
const COL = { host: { x: 8, w: 170 }, path: { x: 230, w: 300 }, port: { x: 590, w: 150 }, proc: { x: 800, w: 230 } };
const W = COL.proc.x + COL.proc.w + 8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Node = { key: string; y: number; label: string; sub?: string; tone: "plain" | "error" | "warn" | "muted" | "ok" };

/** Nodes stacked at their wanted y, pushed down so none overlaps the one above. */
function stack(nodes: Node[]): Node[] {
  const sorted = [...nodes].sort((a, b) => a.y - b.y);
  let floor = PAD;
  for (const n of sorted) {
    n.y = Math.max(n.y, floor);
    floor = n.y + STEP;
  }
  return sorted;
}

const TONE: Record<Node["tone"], string> = {
  plain: "fill-background stroke-border",
  ok: "fill-emerald-500/10 stroke-emerald-500/60",
  muted: "fill-muted stroke-border",
  warn: "fill-amber-500/10 stroke-amber-500/70",
  error: "fill-red-500/10 stroke-red-500/70",
};

function Box({ x, w, n }: { x: number; w: number; n: Node }) {
  return (
    <g>
      <rect x={x} y={n.y} width={w} height={ROW} rx={6} className={cn("stroke-1", TONE[n.tone])} />
      <text x={x + 8} y={n.y + (n.sub ? 12 : 19)} className="fill-foreground font-mono text-[11px]">{n.label}</text>
      {n.sub && <text x={x + 8} y={n.y + 24} className="fill-muted-foreground text-[9px]">{n.sub}</text>}
    </g>
  );
}

/** A soft curve from the right edge of one box to the left edge of the next. */
function Edge({ x1, y1, x2, y2, tone }: { x1: number; y1: number; x2: number; y2: number; tone?: "error" | "warn" }) {
  const mx = (x1 + x2) / 2;
  return (
    <path
      d={`M${x1},${y1 + ROW / 2} C${mx},${y1 + ROW / 2} ${mx},${y2 + ROW / 2} ${x2},${y2 + ROW / 2}`}
      fill="none"
      className={cn("stroke-1", tone === "error" ? "stroke-red-500/70" : tone === "warn" ? "stroke-amber-500/70" : "stroke-muted-foreground/40")}
    />
  );
}

/**
 * The routes as a map (T242): hosts → paths → upstream ports (or a redirect,
 * files, a socket) → what listens there. A port two apps share shows red, a port
 * nothing listens on amber. Laid out without measuring: one row per path, each
 * other node at the middle of its paths, pushed down to clear the one above.
 */
export function RoutesDiagram({ rows }: { rows: RouteRow[] }) {
  const layout = useMemo(() => {
    const pathY = rows.map((_, i) => PAD + i * STEP);
    const mid = (ys: number[]) => ys.reduce((a, b) => a + b, 0) / ys.length;

    const hostIdx = new Map<string, number[]>();
    rows.forEach((r, i) => hostIdx.set(r.server.id, [...(hostIdx.get(r.server.id) ?? []), i]));
    const hosts = stack([...hostIdx].map(([id, idx]) => {
      const s = rows[idx[0]].server;
      return { key: id, y: mid(idx.map((i) => pathY[i])), label: clip(hostsOf(s), 22), sub: `${listenOf(s)}${s.tls ? " · TLS" : ""}`, tone: "muted" as const };
    }));

    // the upstream column: one node per local port, else one per route (a redirect, files…)
    const upKey = (r: RouteRow) => {
      const port = localPortOf(r.route);
      return port !== null ? `p${port}` : `r${r.route.id}`;
    };
    const upIdx = new Map<string, number[]>();
    rows.forEach((r, i) => upIdx.set(upKey(r), [...(upIdx.get(upKey(r)) ?? []), i]));
    const ups = stack([...upIdx].map(([key, idx]) => {
      const r = rows[idx[0]];
      const isPort = key.startsWith("p");
      const dup = idx.some((i) => rows[i].problems.some((p) => p.kind === "duplicate-port" && p.level === "error"));
      const label = isPort ? `:${key.slice(1)}` : clip(upstreamText(r.route), 20);
      return { key, y: mid(idx.map((i) => pathY[i])), label, sub: isPort ? (idx.length > 1 ? `${idx.length} paths` : undefined) : r.route.upstream.kind, tone: dup ? ("error" as const) : isPort ? ("plain" as const) : ("muted" as const) };
    }));
    const upY = new Map(ups.map((n) => [n.key, n.y]));

    const procs = ups.filter((n) => n.key.startsWith("p")).map((n) => {
      const r = rows[upIdx.get(n.key)![0]];
      const l = r.listener;
      return l
        ? { key: n.key, y: n.y, label: clip(listenerName(l), 26), sub: l.pid ? `${clip(l.process ?? "", 18)} · pid ${l.pid}` : "not ours", tone: "ok" as const }
        : { key: n.key, y: n.y, label: "nothing listening", sub: r.app ? `${r.app.project} ${r.app.running ? "running" : "stopped"}` : undefined, tone: "warn" as const };
    });

    const hostY = new Map(hosts.map((n) => [n.key, n.y]));
    const paths: Node[] = rows.map((r, i) => ({
      key: r.route.id, y: pathY[i],
      label: clip(`${r.route.modifier ? `${r.route.modifier} ` : ""}${r.route.path}`, 40),
      sub: r.route.generated ? "generated" : `hand-written · ${r.route.file.split("/").pop()}`,
      tone: r.problems.some((p) => p.level === "error") ? "error" : r.problems.some((p) => p.level === "warn") ? "warn" : "plain",
    }));
    const height = Math.max(PAD * 2 + rows.length * STEP, ...hosts.map((n) => n.y + STEP + PAD), ...ups.map((n) => n.y + STEP + PAD));
    return { hosts, ups, procs, paths, hostY, upY, upKey, height };
  }, [rows]);

  if (!rows.length) return <p className="p-6 text-center text-sm text-muted-foreground">No route matches.</p>;
  const { hosts, ups, procs, paths, hostY, upY, upKey, height } = layout;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full min-w-[900px]" role="img" aria-label="Hosts to paths to ports to processes">
      {/* column heads are the table's: Host, Path, Upstream, Listening */}
      {rows.map((r, i) => (
        <g key={r.route.id}>
          <Edge x1={COL.host.x + COL.host.w} y1={hostY.get(r.server.id)!} x2={COL.path.x} y2={paths[i].y} />
          <Edge x1={COL.path.x + COL.path.w} y1={paths[i].y} x2={COL.port.x} y2={upY.get(upKey(r))!} tone={paths[i].tone === "error" ? "error" : undefined} />
        </g>
      ))}
      {procs.map((n) => <Edge key={n.key} x1={COL.port.x + COL.port.w} y1={n.y} x2={COL.proc.x} y2={n.y} tone={n.tone === "warn" ? "warn" : undefined} />)}
      {hosts.map((n) => <Box key={n.key} x={COL.host.x} w={COL.host.w} n={n} />)}
      {paths.map((n) => <Box key={n.key} x={COL.path.x} w={COL.path.w} n={n} />)}
      {ups.map((n) => <Box key={n.key} x={COL.port.x} w={COL.port.w} n={n} />)}
      {procs.map((n) => <Box key={n.key} x={COL.proc.x} w={COL.proc.w} n={n} />)}
    </svg>
  );
}
