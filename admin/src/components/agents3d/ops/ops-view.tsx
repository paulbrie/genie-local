"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TASK_COLORS, TOOL_COLORS } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";
import { TAG_COLORS } from "@/lib/comms-colors";
import { beamColor, Desk, DeskStyles } from "./desk-sprites";
import { deskParts, deskRow, rowRoom } from "./desks";
import { blockAt, districtAt, districtLabels, isoMap, litDrawList, type IsoBlock, type IsoDistrict, type IsoMap, type P2 } from "./iso";
import type { CodeWin } from "./code-window";
import { LANE_MS, litKey, SPARK_MS, SPARK_N, type LitKind, type OpsAgent, type OpsModel } from "./model";

// (Monaco and its windows: loaded only when the first file is opened, T197)
const CodeWindows = dynamic(() => import("./code-window"), { ssr: false });

/**
 * The 2D "Ops" view of Agents City (T163, T143's concepts A and B): each agent's card and the tasks' swimlanes on
 * top, the repos below as an isometric map (files as small blocks, height by size; folders as districts), the agents
 * seated at a row of desks in front of it (T198), a beam from each one's computer to the file it works on, the latest
 * messages as arcs between them.
 *
 * Cheap by design (T143): the blocks are two Canvas 2D layers, the whole map drawn once per layout (back to front)
 * and the lit files (touched lately, held, claimed twice) drawn over it only when that set changes; the agents and
 * labels a thin SVG layer; the cards DOM. Nothing loops: the desks stay where they are (a beam moves to another
 * file at once), a screen's lines blink a few times on a new tool call (CSS, finite), then all is still; what the
 * clock's ticks bring (4 a second at most) changes only what changed; in a hidden tab nothing is drawn until it shows
 * again. `data-draws` on the root counts the canvas draws, for checking it.
 */

const EXT: Record<string, string> = { ts: "#4f6fa8", tsx: "#5d82c4", js: "#a39a52", jsx: "#b0a65a", mjs: "#a39a52", json: "#6b7a5c", md: "#5c8f6b", css: "#8f5c8f", sql: "#8f765c", py: "#5c8a8f", sh: "#777", yml: "#7a6b8f", yaml: "#7a6b8f" };
const LIT: Record<LitKind, string> = { edit: TOOL_COLORS.edit, read: TOOL_COLORS.read, held: "#e2e8f0", clash: "#ef4444" };
const DOING: Record<OpsAgent["doing"], string> = { type: "editing", read: "reading", run: "running", think: "thinking", idle: "idle", nap: "napping", wait: "waiting for you" };

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

type Fit = { k: number; ox: number; oy: number };
/** the map fitted to its box, with room above for the cities' names and below (`bottom` px) for the desks' row */
function fitOf(map: IsoMap, w: number, h: number, bottom: number): Fit {
  const b = map.bounds, side = 24, top = 28;
  const k = Math.max(0.1, Math.min((w - side * 2) / (b.x1 - b.x0 || 1), (h - top - bottom) / (b.y1 - b.y0 || 1)));
  return { k, ox: (w - (b.x1 - b.x0) * k) / 2 - b.x0 * k, oy: top + (h - top - bottom - (b.y1 - b.y0) * k) / 2 - b.y0 * k };
}
const px = (f: Fit, p: P2): P2 => ({ x: f.ox + p.x * f.k, y: f.oy + p.y * f.k });

function poly(g: CanvasRenderingContext2D, pts: P2[]) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
}
function drawBlock(g: CanvasRenderingContext2D, b: IsoBlock, base: string, glow = false) {
  poly(g, b.left);
  g.fillStyle = shade(base, glow ? 0.8 : 0.62);
  g.fill();
  poly(g, b.right);
  g.fillStyle = shade(base, glow ? 0.62 : 0.45);
  g.fill();
  poly(g, b.top);
  g.fillStyle = shade(base, glow ? 1.15 : 0.9);
  g.fill();
}
/** a canvas sized to its box at the device's pixel ratio (at most 2), with the map's fit applied */
function prepare(c: HTMLCanvasElement, w: number, h: number, f: Fit) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  g.setTransform(dpr * f.k, 0, 0, dpr * f.k, dpr * f.ox, dpr * f.oy);
  return g;
}

/** the element's size, kept as it changes */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** whether the tab shows (nothing is drawn while it doesn't) */
function useVisible() {
  const [v, setV] = useState(true);
  useEffect(() => {
    const f = () => setV(document.visibilityState === "visible");
    f();
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return v;
}

export function OpsView({ model, layout, selectedAgent, onAgentClick, onMessage, onFile }: {
  model: OpsModel;
  layout: CityLayout;
  selectedAgent: string | null;
  onAgentClick: (key: string) => void;
  onMessage?: (id: string) => void;
  /** a block clicked: its file key */
  onFile?: (key: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draws = useRef(0);
  const count = () => {
    draws.current++;
    rootRef.current?.setAttribute("data-draws", String(draws.current));
  };
  const visible = useVisible();
  // (files opened by a right-click on the map, each in its own window: T197)
  const [wins, setWins] = useState<CodeWin[]>([]);
  const nextWin = useRef(1);
  const openFile = (repo: string, path: string) => {
    if (wins.some((w) => w.repo === repo && w.path === path)) return;
    setWins((ws) => [...ws, { id: nextWin.current++, repo, path, repoName: layout.cities.find((c) => c.repo === repo)?.name ?? repo.split("/").pop() ?? repo }]);
  };
  return (
    <div ref={rootRef} data-draws="0" className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2 text-white">
      {wins.length > 0 && <CodeWindows wins={wins} onClose={(id) => setWins((ws) => ws.filter((w) => w.id !== id))} />}
      <div className="max-h-[46%] shrink-0 space-y-2 overflow-y-auto pr-1">
        <Header model={model} />
        <Cards model={model} selected={selectedAgent} onAgentClick={onAgentClick} />
        <Messages model={model} onMessage={onMessage} />
        <Lanes model={model} visible={visible} onDraw={count} />
      </div>
      <IsoCity model={model} layout={layout} selected={selectedAgent} visible={visible} onDraw={count} onAgentClick={onAgentClick} onFile={onFile} onOpenFile={openFile} />
    </div>
  );
}

function Header({ model }: { model: OpsModel }) {
  const c = model.counts;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="mr-1 font-medium text-white/80">{model.agents.length} agents</span>
      {(["dispatched", "in_progress", "blocked", "done"] as const).map((s) => (
        <span key={s} className="rounded-full bg-white/10 px-2 py-0.5" style={{ color: TASK_COLORS[s] }}>
          {s.replace("_", " ")} {c[s]}
        </span>
      ))}
      {!model.live && <span className="ml-auto text-white/60">replay · {clock(model.t)}</span>}
    </div>
  );
}

function Cards({ model, selected, onAgentClick }: { model: OpsModel; selected: string | null; onAgentClick: (k: string) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">
      {model.agents.map((a) => {
        const waiting = a.doing === "wait";
        const still = a.doing === "idle" || a.doing === "nap";
        const state = waiting ? (a.waitFor === "permission" ? "waiting for your OK" : "waiting for you") : a.busy && a.lastTool ? a.lastTool : DOING[a.doing];
        const max = Math.max(1, ...a.spark);
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => onAgentClick(a.key)}
            className={`rounded-md border bg-white/[0.04] px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.08] ${
              waiting ? "border-amber-400 ring-1 ring-amber-400/60" : selected === a.key ? "border-white/70" : "border-white/10"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color, opacity: still ? 0.45 : 1 }} />
              <span className="truncate font-medium">{a.name}</span>
              <span className={`ml-auto shrink-0 text-[11px] ${waiting ? "text-amber-400" : "text-white/60"}`}>{state}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-white/70" title={a.focusPath ?? undefined}>
              {a.focusPath ? a.focusPath.split("/").slice(-2).join("/") : still ? " " : DOING[a.doing]}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
              {a.task ? (
                <>
                  <span className="shrink-0 rounded px-1 font-mono" style={{ background: `${TASK_COLORS[a.task.state]}33`, color: TASK_COLORS[a.task.state] }}>
                    {a.task.id ?? "task"}
                  </span>
                  <span className="truncate text-white/70">{a.task.title}</span>
                </>
              ) : (
                <span className="text-white/40">{a.managing ? `dispatching · ${a.managing} open` : "no task"}</span>
              )}
              {/* (its last hour: tool calls in 3-minute steps) */}
              <svg className="ml-auto shrink-0" width={SPARK_N * 3} height={12} aria-label="Activity, last hour">
                {a.spark.map((n, i) => (
                  <rect key={i} x={i * 3} y={12 - Math.max(1, (n / max) * 12)} width={2} height={Math.max(1, (n / max) * 12)} fill={n ? a.color : "#ffffff22"} />
                ))}
              </svg>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Messages({ model, onMessage }: { model: OpsModel; onMessage?: (id: string) => void }) {
  if (!model.msgs.length) return null;
  const name = (k: string) => model.agents.find((a) => a.key === k)?.name ?? "…";
  return (
    <div className="flex flex-wrap gap-1 text-[11px]">
      {model.msgs.map((m) => (
        <button key={m.id} type="button" onClick={() => onMessage?.(m.id)} className="max-w-[24rem] truncate rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-left text-white/75 hover:bg-white/[0.08]">
          <span className="font-mono font-bold" style={{ color: m.tag ? TAG_COLORS[m.tag] : "#94a3b8" }}>{m.tag ?? "note"}</span> {name(m.from)} → {name(m.to)} · {m.label}
        </button>
      ))}
    </div>
  );
}

/** the tasks over the last hour, a row per agent; drawn when they change, or once a minute as time passes */
function Lanes({ model, visible, onDraw }: { model: OpsModel; visible: boolean; onDraw: () => void }) {
  const [box, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const rows = model.agents.filter((a) => model.bars.has(a.key));
  const t = Math.floor(model.t / 60_000) * 60_000;
  const key = JSON.stringify([t, size.w, rows.map((a) => [a.key, a.color, model.bars.get(a.key)])]);
  const H = 18 + rows.length * 18;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !visible || !size.w || !rows.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = size.w;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = "10px ui-sans-serif, system-ui";
    g.textBaseline = "middle";
    const L = 84, X = (ms: number) => L + ((W - L - 4) * (ms - (t - LANE_MS))) / LANE_MS;
    g.fillStyle = "#94a3b8";
    for (let m = 0; m <= 60; m += 15) {
      const x = X(t - m * 60_000);
      g.fillRect(x, 12, 1, H - 12);
      g.fillText(m ? `−${m}m` : "now", Math.min(W - 22, x - 8), 6);
    }
    rows.forEach((a, r) => {
      const y = 16 + r * 18;
      g.fillStyle = a.color;
      g.fillRect(4, y + 5, 6, 6);
      g.fillStyle = "#e2e8f0";
      g.fillText(a.name.slice(0, 12), 14, y + 8);
      for (const b of model.bars.get(a.key) ?? []) {
        const x0 = Math.max(L, X(b.from)), x1 = Math.min(W - 4, X(b.to ?? t));
        if (x1 <= L) continue;
        g.globalAlpha = 0.85;
        g.fillStyle = TASK_COLORS[b.state];
        g.fillRect(x0, y + 1, Math.max(2, x1 - x0), 14);
        g.globalAlpha = 1;
        g.save();
        g.beginPath();
        g.rect(x0 + 2, y, Math.max(0, x1 - x0 - 4), 16);
        g.clip();
        g.fillStyle = b.state === "in_progress" || b.state === "done" ? "#0b0f17" : "#fff";
        g.fillText(`${b.id ?? ""} ${b.title}`, x0 + 3, y + 8);
        g.restore();
      }
    });
    onDraw();
    // (drawn again only when what it shows changes: `key`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible]);
  return (
    <div ref={box} className="w-full">
      {rows.length > 0 && <canvas ref={canvas} style={{ width: "100%", height: H }} aria-label="Tasks over the last hour, a row per agent" />}
    </div>
  );
}

function IsoCity({ model, layout, selected, visible, onDraw, onAgentClick, onFile, onOpenFile }: {
  model: OpsModel; layout: CityLayout; selected: string | null; visible: boolean; onDraw: () => void;
  onAgentClick: (k: string) => void; onFile?: (k: string) => void;
  /** a block right-clicked: its file, to read (T197) */
  onOpenFile?: (repo: string, path: string) => void;
}) {
  const [box, size] = useSize<HTMLDivElement>();
  const base = useRef<HTMLCanvasElement>(null);
  const litC = useRef<HTMLCanvasElement>(null);
  const map = useMemo(() => isoMap(layout), [layout]);
  // (the desks' row along the front, under the map: its scale decides the room it takes)
  const row = useMemo(() => deskRow(model.agents.length, size.w, size.h), [model.agents.length, size.w, size.h]);
  const fit = useMemo(() => fitOf(map, size.w, size.h, rowRoom(row.u)), [map, size.w, size.h, row.u]);
  const lk = litKey(model.lit);

  // the map, once per layout and size
  useEffect(() => {
    const c = base.current;
    if (!c || !visible || !size.w || !size.h) return;
    const g = prepare(c, size.w, size.h, fit);
    for (const city of map.cities) {
      poly(g, city.ground);
      g.fillStyle = "#0f1522";
      g.fill();
    }
    for (const d of map.districts) {
      poly(g, d.pts);
      g.fillStyle = d.depth % 2 ? "#141c2b" : "#18213300";
      g.fill();
      g.strokeStyle = "#ffffff10";
      g.lineWidth = 0.6 / fit.k;
      g.stroke();
    }
    for (const b of map.blocks) drawBlock(g, b, EXT[b.ext] ?? "#4b5563");
    onDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fit, visible]);

  // the lit files, when that set changes (at most 4 a second: the clock's ticks), with what stands in front of them
  useEffect(() => {
    const c = litC.current;
    if (!c || !visible || !size.w || !size.h) return;
    const g = prepare(c, size.w, size.h, fit);
    const lit = new Map<number, LitKind>();
    for (const [k, v] of model.lit) {
      const i = layout.index.get(k);
      if (i !== undefined) lit.set(i, v.kind);
    }
    const colorOf = new Map(model.agents.map((a) => [a.key, a.color]));
    for (const n of litDrawList(map, lit.keys())) {
      const b = map.blocks[n], kind = lit.get(b.i);
      if (!kind) {
        drawBlock(g, b, EXT[b.ext] ?? "#4b5563");
        continue;
      }
      const by = model.lit.get(b.key)?.by;
      drawBlock(g, b, kind === "held" && by ? (colorOf.get(by) ?? LIT.held) : LIT[kind], true);
      if (kind === "clash" || kind === "held") {
        poly(g, b.top);
        g.strokeStyle = kind === "clash" ? "#ef4444" : "#ffffff";
        g.lineWidth = 1.2 / fit.k;
        g.stroke();
      }
    }
    onDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk, map, fit, visible]);

  // each agent's seat at its desk (in the agents' order), and the top of the file it works on, if laid out
  const spots = useMemo(() => {
    const out = new Map<string, { at: P2; peak: P2 | null }>();
    model.agents.forEach((a, n) => {
      const i = a.focus ? layout.index.get(a.focus) : undefined;
      const m = i !== undefined ? map.order.get(i) : undefined;
      out.set(a.key, { at: row.seats[n], peak: m !== undefined ? px(fit, map.blocks[m].peak) : null });
    });
    return out;
  }, [model.agents, layout, map, fit, row]);
  const beamFrom = deskParts(row.u).beam;

  // the neighbourhoods' (folders') names: the biggest first, where they fit, never overlapping (T192); once per layout and size
  const cityBoxes = useMemo(() => map.cities.map((c) => { const p = px(fit, c.at); return { x: p.x, y: p.y - 10, w: c.name.length * 8 + 8, h: 14 }; }), [map, fit]);
  const labels = useMemo(() => (size.w ? districtLabels(map, (p) => px(fit, p), fit.k, cityBoxes) : []), [map, fit, size.w, cityBoxes]);
  // (files in each folder, for its hover card)
  const filesIn = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of layout.buildings) {
      const parts = b.path.split("/");
      for (let i = 1; i < parts.length; i++) { const k = `${b.repo}\n${parts.slice(0, i).join("/")}`; m.set(k, (m.get(k) ?? 0) + 1); }
    }
    return m;
  }, [layout]);
  const [hover, setHover] = useState<{ x: number; y: number; path: string; folder: IsoDistrict | null; block: IsoBlock | null } | null>(null);
  const toMap = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, p: { x: (sx - fit.ox) / fit.k, y: (sy - fit.oy) / fit.k } };
  };
  const byKey = new Map(model.agents.map((a) => [a.key, a]));
  return (
    <div
      ref={box}
      className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-white/10 bg-[#0b0f17]"
      onMouseMove={(e) => {
        const { sx, sy, p } = toMap(e);
        // (over a block: its file; over the ground: its neighbourhood, the deepest folder there)
        const b = blockAt(map, p), folder = districtAt(map, p);
        const path = b ? layout.buildings[b.i].path : folder ? `${folder.dir}/` : null;
        setHover((h) => (path === null ? null : h?.path === path && h.folder === folder && Math.abs(h.x - sx) < 40 && Math.abs(h.y - sy) < 40 ? h : { x: sx, y: sy, path, folder, block: b }));
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const b = blockAt(map, toMap(e).p);
        if (b) onFile?.(b.key);
      }}
      onContextMenu={(e) => {
        // (a file's column: read it in a code window; elsewhere the browser's own menu)
        const b = blockAt(map, toMap(e).p);
        if (!b || !onOpenFile) return;
        e.preventDefault();
        const f = layout.buildings[b.i];
        onOpenFile(f.repo, f.path);
      }}
    >
      <canvas ref={base} className="absolute inset-0 size-full" aria-hidden />
      <canvas ref={litC} className="absolute inset-0 size-full" aria-hidden />
      <svg className="absolute inset-0 size-full" width={size.w} height={size.h}>
        {map.cities.map((c) => {
          const p = px(fit, c.at);
          return (
            <text key={c.repo} x={p.x} y={p.y - 6} textAnchor="middle" className="fill-slate-300 text-[11px] font-semibold tracking-wider" style={{ paintOrder: "stroke", stroke: "#0b0f17", strokeWidth: 3 }}>
              {c.name.toUpperCase()}
            </text>
          );
        })}
        {/* the column under the pointer: its top lit and outlined (T197) */}
        {hover?.block && (() => {
          const top = hover.block.top.map((q) => px(fit, q)), peak = px(fit, hover.block.peak);
          // (a top a few pixels wide, the map seen whole: a ring round it too, so it is seen)
          const small = Math.max(...top.map((p) => p.x)) - Math.min(...top.map((p) => p.x)) < 10;
          return (
            <g className="pointer-events-none">
              <polygon points={top.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill="#ffffff" fillOpacity={0.55} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
              {small && <circle cx={peak.x} cy={peak.y} r={6} fill="none" stroke="#ffffff" strokeWidth={1.5} />}
            </g>
          );
        })()}
        {/* the neighbourhood under the pointer: its ground outlined */}
        {hover?.folder && <polygon points={hover.folder.pts.map((q) => { const p = px(fit, q); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ")} fill="none" stroke="#ffffff" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 2" />}
        {/* the neighbourhoods' names, on their ground */}
        {labels.map((l) => (
          <g key={l.key} transform={`translate(${l.x.toFixed(1)},${l.y.toFixed(1)})`} className="pointer-events-none">
            <rect x={-l.w / 2} y={-l.h / 2} width={l.w} height={l.h} rx={3} fill="#0b0f17" fillOpacity={0.72} />
            <text y={3.5} textAnchor="middle" className={`font-mono ${l.depth === 0 ? "fill-slate-100 text-[10px] font-semibold" : "fill-slate-300 text-[10px]"}`}>{l.text}</text>
          </g>
        ))}
        {/* the latest messages: an arc from sender to receiver */}
        {model.msgs.map((m) => {
          const a = spots.get(m.from)?.at, b = spots.get(m.to)?.at;
          if (!a || !b || (a.x === b.x && a.y === b.y)) return null;
          // (over the row, from head to head)
          const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 30 * row.u - 10 - Math.abs(a.x - b.x) * 0.12;
          return <path key={m.id} d={`M${a.x},${a.y - 30 * row.u} Q${mx},${my} ${b.x},${b.y - 30 * row.u}`} fill="none" stroke={m.tag ? TAG_COLORS[m.tag] : "#94a3b8"} strokeWidth={1.4} strokeDasharray="4 3" opacity={0.75} />;
        })}
        <DeskStyles />
        {/* each agent's beam: from its computer to the file it works on (edited or read), under the desks */}
        {model.agents.map((a) => {
          const s = spots.get(a.key);
          if (!s?.peak || !s.at) return null;
          const x1 = s.at.x + beamFrom.x, y1 = s.at.y + beamFrom.y;
          return (
            <g key={`b${a.key}`} className="pointer-events-none" opacity={selected && selected !== a.key ? 0.3 : 0.85}>
              <line x1={x1} y1={y1} x2={s.peak.x} y2={s.peak.y} stroke={beamColor(a)} strokeWidth={1.4} />
              <circle cx={s.peak.x} cy={s.peak.y} r={2.4} fill={beamColor(a)} />
            </g>
          );
        })}
        {/* the desks' row, in front of the codebases */}
        {model.agents.map((a) => {
          const s = spots.get(a.key);
          return s?.at ? <Desk key={a.key} a={a} at={s.at} u={row.u} selected={selected === a.key} onClick={() => onAgentClick(a.key)} /> : null;
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 max-w-[28rem] truncate rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white" style={{ left: Math.min(hover.x + 12, size.w - 200), top: hover.y + 12 }}>
          {hover.path}
          {hover.path.endsWith("/") && hover.folder && ` · ${filesIn.get(`${hover.folder.repo}\n${hover.folder.dir}`) ?? 0} files`}
          {byKey.size > 0 && (() => {
            const l = [...model.lit].find(([k]) => k.endsWith(`\n${hover.path}`))?.[1];
            return l ? ` · ${l.kind}${l.by ? ` (${byKey.get(l.by)?.name ?? "…"})` : ""}` : "";
          })()}
          {/* (a file: the neighbourhood it is in, outlined on the map) */}
          {!hover.path.endsWith("/") && hover.folder && (
            <span className="block text-white/60">in {hover.folder.dir}/ · {filesIn.get(`${hover.folder.repo}\n${hover.folder.dir}`) ?? 0} files</span>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-1.5 right-2 flex gap-2 text-[10px] text-white/60">
        <span><i className="mr-1 inline-block size-2 rounded-sm" style={{ background: LIT.edit }} />edited</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm" style={{ background: LIT.read }} />read</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm border border-white" />held</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm" style={{ background: LIT.clash }} />claimed twice</span>
        <span>· last {Math.round((SPARK_MS * SPARK_N) / 60_000)} min on the cards</span>
      </div>
    </div>
  );
}
