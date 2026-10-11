"use client";

import { ChevronRight } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TASK_COLORS } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";
import { TAG_COLORS } from "@/lib/comms-colors";
import { Belts } from "./belt-sprites";
import { bubbleAt, Bubbles, estimate, HEAD_TOP, layoutBubbles, type Measure } from "./bubbles";
import { local as deskLocal } from "./desks";
import { Curve, Desk, DeskName, DeskStyles, KIND_COLORS, linkColor, ManagerLink } from "./desk-sprites";
import { deskLine, deskParts, deskSpots, L } from "./desks";
import { blockAt, districtAt, districtLabels, inPoly, iso, isoMap, litDrawList, type IsoBlock, type IsoDistrict, type IsoMap, type P2 } from "./iso";
import type { CodeWin } from "./code-window";
import { cssBetween, FIT_VIEW, keepCentre, maxS, panBy, viewFit, viewFromStore, viewOfBox, viewToStore, zoomAt, type View } from "./map-view";
import { LANE_MS, litKey, SPARK_MS, SPARK_N, type LitKind, type OpsAgent, type OpsModel } from "./model";

// (Monaco and its windows: loaded only when the first file is opened, T197)
const CodeWindows = dynamic(() => import("./code-window"), { ssr: false });

/**
 * The 2D "Ops" view of Agents City (T163, T143's concepts A and B): each agent's card and the tasks' swimlanes on
 * top, the repos below as an isometric map (files as small blocks, height by size; folders as districts), the agents
 * seated at a row of desks on the map's ground in front of it (T198, T201), glowing curves from each one's computer to
 * the files it edits, reads or has claimed, the commits riding conveyor belts along their cities' far sides, the
 * latest messages as arcs between them.
 *
 * Cheap by design (T143): the blocks are two Canvas 2D layers, the whole map drawn once per layout (back to front)
 * and the lit files (touched lately, held, claimed twice) drawn over it only when that set changes; the agents and
 * labels a thin SVG layer; the cards DOM. Nothing loops: the desks stay where they are (a beam moves to another
 * file at once), a screen's lines blink a few times on a new tool call (CSS, finite), then all is still; what the
 * clock's ticks bring (4 a second at most) changes only what changed; in a hidden tab nothing is drawn until it shows
 * again. `data-draws` on the root counts the canvas draws, for checking it.
 */

const EXT: Record<string, string> = { ts: "#4f6fa8", tsx: "#5d82c4", js: "#a39a52", jsx: "#b0a65a", mjs: "#a39a52", json: "#6b7a5c", md: "#5c8f6b", css: "#8f5c8f", sql: "#8f765c", py: "#5c8a8f", sh: "#777", yml: "#7a6b8f", yaml: "#7a6b8f" };
// (a lit file in the curves' colours, T201: edited orange, read green, claimed red, claimed twice red and outlined)
const LIT: Record<LitKind, string> = { edit: KIND_COLORS.edit, read: KIND_COLORS.read, held: KIND_COLORS.claim, clash: KIND_COLORS.claim };
const DOING: Record<OpsAgent["doing"], string> = { type: "editing", read: "reading", run: "running", think: "thinking", idle: "idle", nap: "napping", wait: "waiting for you" };

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

type Fit = { k: number; ox: number; oy: number };
/** the manager's desk, larger than the agents' (T204e) */
const MANAGER_SCALE = 1.25;
/** room under the map for the front desks' names (px) */
const NAMES_H = 26;
/** the map's zoom and pan, kept for the browser session (T200) */
const VIEW_KEY = "admin.agents3d.ops.view";
/** the map with its bounds grown to take in `extra` (screen units) */
function withExtent(m: IsoMap, extra: P2[]): IsoMap {
  const xs = [m.bounds.x0, m.bounds.x1, ...extra.map((p) => p.x)], ys = [m.bounds.y0, m.bounds.y1, ...extra.map((p) => p.y)];
  return { ...m, bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}
/** the map fitted to its box, with room above for the cities' names and below (`bottom` px) for the desks' names */
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

export function OpsView({ model, layout, selectedAgent, onAgentClick, onMessage, onFile, resetCam, lowPower }: {
  model: OpsModel;
  layout: CityLayout;
  selectedAgent: string | null;
  onAgentClick: (key: string) => void;
  onMessage?: (id: string) => void;
  /** a block clicked: its file key */
  onFile?: (key: string) => void;
  /** a new value: back to the whole map (Escape with nothing else to close, as the 3D camera's reset) */
  resetCam?: number;
  /** the Low power switch (T162): the view's motion (typing hands, pulses, rides, glides) held still */
  lowPower?: boolean;
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
    <div ref={rootRef} data-draws="0" data-low-power={lowPower || undefined} className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2 text-white">
      {wins.length > 0 && <CodeWindows wins={wins} onClose={(id) => setWins((ws) => ws.filter((w) => w.id !== id))} />}
      {/* (on top: the counts, the latest messages, the folded timeline; under the map, the agents' cards: T207) */}
      <div className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto pr-1">
        <Header model={model} />
        <Messages model={model} onMessage={onMessage} />
        <Lanes model={model} visible={visible} onDraw={count} />
      </div>
      <IsoCity model={model} layout={layout} selected={selectedAgent} visible={visible} onDraw={count} onAgentClick={onAgentClick} onFile={onFile} onOpenFile={openFile} resetCam={resetCam} />
      <Cards model={model} selected={selectedAgent} onAgentClick={onAgentClick} />
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
    // (one row under the map, as many as fit across; more scroll sideways, so the page never grows: T207)
    <div className="grid shrink-0 auto-cols-[minmax(190px,1fr)] grid-flow-col gap-1.5 overflow-x-auto pb-0.5" aria-label="The agents">
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
      {model.msgs.slice(-6).map((m) => (
        <button key={m.id} type="button" onClick={() => onMessage?.(m.id)} className="max-w-[24rem] truncate rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-left text-white/75 hover:bg-white/[0.08]">
          <span className="font-mono font-bold" style={{ color: m.tag ? TAG_COLORS[m.tag] : "#94a3b8" }}>{m.tag ?? "note"}</span> {name(m.from)} → {name(m.to)} · {m.label}
        </button>
      ))}
    </div>
  );
}

/** the tasks over the last hour, a row per agent; drawn when they change, or once a minute as time passes */
/** the timeline folded or open, kept in this browser; folded until opened (T203) */
const LANES_KEY = "admin.agents3d.ops.lanes";

function Lanes({ model, visible, onDraw }: { model: OpsModel; visible: boolean; onDraw: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(LANES_KEY) === "1") setOpen(true); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  const toggle = () => {
    localStorage.setItem(LANES_KEY, open ? "0" : "1");
    setOpen(!open);
  };
  const [box, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const rows = model.agents.filter((a) => model.bars.has(a.key));
  const t = Math.floor(model.t / 60_000) * 60_000;
  const key = JSON.stringify([t, size.w, rows.map((a) => [a.key, a.color, model.bars.get(a.key)])]);
  const H = 18 + rows.length * 18;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !open || !visible || !size.w || !rows.length) return;
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
    // (drawn again only when what it shows changes: `key`; and when opened)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, open]);
  const tasks = rows.reduce((n, a) => n + (model.bars.get(a.key)?.length ?? 0), 0);
  return (
    <div ref={box} className="w-full">
      {/* (folded: one thin bar; a click opens the swimlanes, and the map gives back the room) */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? "Fold the timeline away" : "Show the tasks over the last hour, a row per agent"}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-white/60 hover:bg-white/[0.06] hover:text-white/85"
      >
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        Timeline · {tasks} task{tasks === 1 ? "" : "s"} in the last {Math.round(LANE_MS / 60_000)} min
      </button>
      {open && rows.length > 0 && <canvas ref={canvas} style={{ width: "100%", height: H }} aria-label="Tasks over the last hour, a row per agent" />}
    </div>
  );
}

function IsoCity({ model, layout, selected, visible, onDraw, onAgentClick, onFile, onOpenFile, resetCam }: {
  model: OpsModel; layout: CityLayout; selected: string | null; visible: boolean; onDraw: () => void;
  onAgentClick: (k: string) => void; onFile?: (k: string) => void;
  /** a block right-clicked: its file, to read (T197) */
  onOpenFile?: (repo: string, path: string) => void;
  resetCam?: number;
}) {
  const [box, size] = useSize<HTMLDivElement>();
  const base = useRef<HTMLCanvasElement>(null);
  const litC = useRef<HTMLCanvasElement>(null);
  const map = useMemo(() => isoMap(layout), [layout]);
  // (the desks and the belts on the map's ground (T201, T204): the fit takes them in)
  const line = useMemo(() => deskLine(layout.cities, model.agents.length), [layout.cities, model.agents.length]);
  // (each agent's desk in front of its city (T204c), far enough out that its head and a bubble (T205: 59 px at the
  // whole map's zoom, as near as the fit without the desks tells) stay clear of the city's blocks)
  const kEst = useMemo(() => fitOf(withExtent(map, line.extent), size.w || 1, size.h || 1, NAMES_H).k, [map, line, size.w, size.h]);
  const desks = useMemo(() => deskSpots(layout.cities, model.agents, line.wu, HEAD_TOP * line.wu + 59 / kEst), [layout.cities, model.agents, line, kEst]);
  const framed = useMemo(() => withExtent(map, [...line.extent, ...desks.extent]), [map, line, desks]);
  const fit0 = useMemo(() => fitOf(framed, size.w, size.h, NAMES_H), [framed, size.w, size.h]);
  // the zoom and pan (T200): `view` is what the layers are drawn for; a gesture moves them by CSS only (`live`), and
  // when it ends the view is set, the layers drawn again and the labels picked again
  const [view, setViewRaw] = useState<View>(FIT_VIEW);
  const fit = useMemo(() => viewFit(fit0, view), [fit0, view]);
  // (the box resized, the timeline folded or opened: the whole map if it showed it, else the same middle and zoom; T203)
  const sized = useRef<{ fit0: Fit; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const p = sized.current;
    sized.current = { fit0, w: size.w, h: size.h };
    if (!p || !p.w || !size.w || (p.w === size.w && p.h === size.h) || box.current?.hasAttribute("data-moving")) return;
    setViewRaw((v) => keepCentre(v, p.fit0, p.w, p.h, fit0, size.w, size.h));
  }, [fit0, size.w, size.h, box]);
  const top = maxS(fit0, size.w || 1);
  const layer = useRef<HTMLDivElement>(null);
  const live = useRef<View | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const setView = (v: View) => {
    live.current = null;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    setViewRaw(v);
    if (size.w) sessionStorage.setItem(VIEW_KEY, JSON.stringify(viewToStore(v, size.w, size.h)));
  };
  /** a gesture's step: the layers moved by CSS, the view set a moment after the last step (`settle` ms) */
  const preview = (v: View, settle: number | null) => {
    live.current = v;
    if (layer.current) layer.current.style.transform = cssBetween(viewRef.current, v);
    box.current?.setAttribute("data-moving", "");
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = settle === null ? null : setTimeout(() => setView(v), settle);
  };
  // (the kept view, once the box has a size)
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !size.w) return;
    restored.current = true;
    try {
      const v = viewFromStore(JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null"), size.w, size.h, top);
      if (v) setViewRaw(v); // eslint-disable-line react-hooks/set-state-in-effect
    } catch {
      // a malformed value: the whole map
    }
  }, [size.w, size.h, top]);
  // (Escape with nothing else to close: the whole map, as the 3D camera goes home)
  const resetSeen = useRef(resetCam);
  useEffect(() => {
    if (resetCam === resetSeen.current) return;
    resetSeen.current = resetCam;
    setView(FIT_VIEW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCam]);
  const lk = litKey(model.lit);

  // the map, once per layout, size and view (before the frame is shown, with the gesture's CSS taken off)
  useLayoutEffect(() => {
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
  useLayoutEffect(() => {
    const c = litC.current;
    if (!c || !visible || !size.w || !size.h) return;
    const g = prepare(c, size.w, size.h, fit);
    const lit = new Map<number, LitKind>();
    for (const [k, v] of model.lit) {
      const i = layout.index.get(k);
      if (i !== undefined) lit.set(i, v.kind);
    }
    for (const n of litDrawList(map, lit.keys())) {
      const b = map.blocks[n], kind = lit.get(b.i);
      if (!kind) {
        drawBlock(g, b, EXT[b.ext] ?? "#4b5563");
        continue;
      }
      drawBlock(g, b, LIT[kind], true);
      // (claimed twice: outlined white)
      if (kind === "clash") {
        poly(g, b.top);
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1.2 / fit.k;
        g.stroke();
      }
    }
    onDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk, map, fit, visible]);

  // (the view set: the layers are drawn for it above, so the gesture's CSS comes off before the frame is shown)
  useLayoutEffect(() => {
    if (live.current) return;
    if (layer.current) layer.current.style.transform = "";
    box.current?.removeAttribute("data-moving");
  }, [view, box]);

  // each agent's seat at its desk (in the agents' order), and the top of the file it works on, if laid out
  const spots = useMemo(() => {
    const out = new Map<string, { at: P2; peak: P2 | null }>();
    model.agents.forEach((a) => {
      const i = a.focus ? layout.index.get(a.focus) : undefined;
      const m = i !== undefined ? map.order.get(i) : undefined;
      const seat = desks.seats.get(a.key)!;
      out.set(a.key, { at: px(fit, iso(seat.x, seat.z)), peak: m !== undefined ? px(fit, map.blocks[m].peak) : null });
    });
    return out;
  }, [model.agents, layout, map, fit, desks]);
  // (the desks back to front: further from the viewer first)
  const deskOrder = useMemo(() => [...model.agents].sort((a, b) => { const p = desks.seats.get(a.key)!, q = desks.seats.get(b.key)!; return p.x + p.z - (q.x + q.z); }), [model.agents, desks]);
  // (the sprites' scale: a desk unit in pixels at this zoom, over its full-size pixels)
  const u = (line.wu * fit.k) / L;
  // (the bubbles' text measured as drawn: the admin's sans at 12 px, T205d)
  const measureText = useMemo<Measure>(() => {
    const g = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (!g) return estimate;
    g.font = `12px ${getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif"}`;
    return (t) => g.measureText(t).width;
  }, []);
  // (the bubbles over the heads, laid out when the agents' steps or the view change: T205)
  const bubbles = useMemo(() => {
    const heads = new Map<string, P2>();
    for (const [k, s] of spots) if (s.at) heads.set(k, { x: s.at.x + deskLocal(0, 0, HEAD_TOP, u).x, y: s.at.y + deskLocal(0, 0, HEAD_TOP, u).y });
    return layoutBubbles(model.agents, heads, u, measureText);
  }, [model.agents, spots, u, measureText]);
  // (a bubble under the pointer: its thoughts whole, T205d)
  const [thought, setThought] = useState<{ x: number; y: number; name: string; lines: string[] } | null>(null);
  const beamFrom = deskParts(u).beam;
  const blockPeak = (file: string) => {
    const i = layout.index.get(file), m = i !== undefined ? map.order.get(i) : undefined;
    return m !== undefined ? px(fit, map.blocks[m].peak) : null;
  };

  // the neighbourhoods' (folders') names: the biggest first, where they fit, never overlapping (T192); once per layout and size
  const cityBoxes = useMemo(() => map.cities.map((c) => { const p = px(fit, c.at); return { x: p.x, y: p.y - 10, w: c.name.length * 8 + 8, h: 14 }; }), [map, fit]);
  // (zoomed in, deeper folders get names too; only those in the box)
  const labels = useMemo(
    () => (size.w ? districtLabels(map, (p) => px(fit, p), fit.k, cityBoxes, 6, 14, 3 + Math.max(0, Math.floor(Math.log2(view.s)))).filter((l) => l.x > -l.w && l.x < size.w + l.w && l.y > -20 && l.y < size.h + 20) : []),
    [map, fit, size.w, size.h, cityBoxes, view.s],
  );
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

  // zoom: the wheel or a trackpad pinch (ctrl + wheel), about the pointer; the view set 180 ms after the last step
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015) * (e.deltaMode === 1 ? 16 : 1));
      setHover(null);
      preview(zoomAt(live.current ?? viewRef.current, f, { x: e.clientX - r.left, y: e.clientY - r.top }, top), 180);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  // keys: + / − zoom about the middle, 0 the whole map (not while typing, nor in a code window)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("[role=dialog]"))) return;
      const mid = { x: size.w / 2, y: size.h / 2 };
      if (e.key === "+" || e.key === "=") setView(zoomAt(viewRef.current, 1.5, mid, top));
      else if (e.key === "-" || e.key === "_") setView(zoomAt(viewRef.current, 1 / 1.5, mid, top));
      else if (e.key === "0") setView(FIT_VIEW);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // pan: drag with the left button (a click if it doesn't move), the middle one, or the right one from off a column
  const drag = useRef<{ x: number; y: number; from: View; button: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button")) return;
    if (e.button === 2 && blockAt(map, toMap(e).p)) return;
    if (e.button > 2) return;
    drag.current = { x: e.clientX, y: e.clientY, from: live.current ?? view, button: e.button, moved: false };
    dragged.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; setHover(null); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
    preview(panBy(d.from, dx, dy), null);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      dragged.current = true;
      if (live.current) setView(live.current);
    }
  };
  // a double-click on a city: zoomed to it
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toMap(e).p;
    const c = map.cities.find((x) => inPoly(p, x.ground));
    if (!c) return;
    const pts = c.ground.map((q) => px(fit0, q));
    setView(viewOfBox({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)) - 30, x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) }, size.w, size.h - NAMES_H, top));
  };
  return (
    <div
      ref={box}
      className="group relative min-h-0 flex-1 touch-none overflow-hidden rounded-md border border-white/10 bg-[#0b0f17] select-none data-[moving]:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onMouseMove={(e) => {
        if (drag.current?.moved || live.current) return;
        const { sx, sy, p } = toMap(e);
        // (over a bubble: its thoughts whole; T205d)
        const bub = bubbleAt(bubbles, { x: sx, y: sy });
        setThought((t) => (!bub ? null : t?.name === bub.key && Math.abs(t.x - sx) < 40 ? t : { x: sx, y: sy, name: byKey.get(bub.key)?.name ?? bub.key, lines: bub.full }));
        if (bub) { setHover(null); return; }
        // (over a block: its file; over the ground: its neighbourhood, the deepest folder there)
        const b = blockAt(map, p), folder = districtAt(map, p);
        const path = b ? layout.buildings[b.i].path : folder ? `${folder.dir}/` : null;
        setHover((h) => (path === null ? null : h?.path === path && h.folder === folder && Math.abs(h.x - sx) < 40 && Math.abs(h.y - sy) < 40 ? h : { x: sx, y: sy, path, folder, block: b }));
      }}
      onMouseLeave={() => { setHover(null); setThought(null); }}
      onClick={(e) => {
        if (dragged.current) { dragged.current = false; return; }
        // (a bubble: its agent picked, its card shown)
        const { sx, sy } = toMap(e), bub = bubbleAt(bubbles, { x: sx, y: sy });
        if (bub) { onAgentClick(bub.key); return; }
        const b = blockAt(map, toMap(e).p);
        if (b) onFile?.(b.key);
      }}
      onContextMenu={(e) => {
        // (the end of a right-drag: no menu)
        if (dragged.current) { e.preventDefault(); dragged.current = false; return; }
        // (a file's column: read it in a code window; elsewhere the browser's own menu)
        const b = blockAt(map, toMap(e).p);
        if (!b || !onOpenFile) return;
        e.preventDefault();
        const f = layout.buildings[b.i];
        onOpenFile(f.repo, f.path);
      }}
    >
      {/* the map's layers: moved together by CSS during a gesture (T200) */}
      <div ref={layer} className="pointer-events-none absolute inset-0 origin-top-left will-change-transform">
      {/* the commits' belts, one along each city's far side, under them (T204): the cities' ground hides what is behind it */}
      <svg className="absolute inset-0 size-full" width={size.w} height={size.h}>
        <Belts line={line} fit={fit} commits={model.commits} agents={model.agents} />
      </svg>
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
        {/* on the map's ground, so they zoom and pan with it (T201), back to front (T202): the desks, the names, then the
            curves and the messages over all (the belt is under the cities: above) */}
        <DeskStyles />
        {/* (in the map's own units, so a zoom doesn't set off the glide a move to another city makes, T204c) */}
        <g transform={`matrix(${fit.k} 0 0 ${fit.k} ${fit.ox} ${fit.oy})`}>
          {deskOrder.map((a) => {
            const seat = desks.seats.get(a.key)!, p = iso(seat.x, seat.z), uu = (line.wu / L) * (a.manager ? MANAGER_SCALE : 1);
            return (
              <g key={a.key} className="ops-seat" style={{ transform: `translate(${p.x.toFixed(3)}px, ${p.y.toFixed(3)}px)` }}>
                <Desk a={a} u={uu} selected={selected === a.key} onClick={() => onAgentClick(a.key)} />
                <DeskName a={a} u={uu} k={fit.k} onClick={() => onAgentClick(a.key)} />
              </g>
            );
          })}
        </g>
        {/* each agent's curves: from its computer to the files it edits, reads or has claimed */}
        {model.links.map((l) => {
          const s = spots.get(l.by), to = blockPeak(l.file), a = byKey.get(l.by);
          if (!s?.at || !to || !a) return null;
          return <Curve key={`${l.by}\n${l.file}`} l={l} from={{ x: s.at.x + beamFrom.x, y: s.at.y + beamFrom.y }} to={to} color={a.color} dim={!!selected && selected !== l.by} u={u} />;
        })}
        {/* the manager's connections (T204e): to each agent it messaged or heard from lately, the latest, by tag */}
        {(() => {
          const boss = model.agents.find((x) => x.manager);
          if (!boss) return null;
          const latest = new Map<string, OpsModel["msgs"][number]>();
          for (const m of model.msgs) if (m.from === boss.key || m.to === boss.key) latest.set(m.from === boss.key ? m.to : m.from, m);
          const head = (k: string, s: number) => { const p = spots.get(k)?.at; return p ? { x: p.x + deskLocal(0, 0, 5, u * s).x, y: p.y + deskLocal(0, 0, 5, u * s).y } : null; };
          return [...latest].map(([other, m]) => {
            const a = head(boss.key, MANAGER_SCALE), b = head(other, 1);
            return a && b ? <ManagerLink key={`m${other}`} id={m.id} from={a} to={b} color={linkColor(m.tag)} fade={m.fade} dim={!!selected && selected !== other && selected !== boss.key} /> : null;
          });
        })()}
        {/* the latest messages between agents (not the manager's): an arc from sender to receiver, head to head */}
        {model.msgs.map((m) => {
          if (byKey.get(m.from)?.manager || byKey.get(m.to)?.manager) return null;
          const a = spots.get(m.from)?.at, b = spots.get(m.to)?.at;
          if (!a || !b || (a.x === b.x && a.y === b.y)) return null;
          const lift = 46 * u, mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - lift - 10 - Math.abs(a.x - b.x) * 0.12;
          return <path key={m.id} d={`M${a.x},${a.y - lift} Q${mx},${my} ${b.x},${b.y - lift}`} fill="none" stroke={m.tag ? TAG_COLORS[m.tag] : "#94a3b8"} strokeWidth={1.4} strokeDasharray="4 3" opacity={0.75} />;
        })}
        {/* the agents' bubbles, their last steps, over everything (T205) */}
        <Bubbles boxes={bubbles} color={(k) => byKey.get(k)?.color ?? "#94a3b8"} />
      </svg>
      </div>
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
      {thought && (
        <div className="pointer-events-none absolute z-10 max-w-[30rem] rounded bg-black/85 px-2 py-1 text-[12px] leading-snug text-white" style={{ left: Math.min(thought.x + 12, size.w - 320), top: thought.y + 12 }}>
          <span className="block text-[11px] text-white/60">{thought.name} is thinking</span>
          {thought.lines.map((l, i) => <span key={i} className="block">{l}</span>)}
        </div>
      )}
      {/* zoom: + − and the whole map (also + − 0, the wheel or a pinch, a drag pans, a double-click on a city frames it) */}
      <div className="absolute top-2 right-2 z-10 flex flex-col overflow-hidden rounded-md border border-white/15 bg-black/60 text-white/80">
        <button type="button" aria-label="Zoom in" title="Zoom in (+, the wheel)" className="px-2 py-0.5 hover:bg-white/10" onClick={() => setView(zoomAt(view, 1.5, { x: size.w / 2, y: size.h / 2 }, top))}>+</button>
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" className="border-t border-white/10 px-2 py-0.5 hover:bg-white/10" onClick={() => setView(zoomAt(view, 1 / 1.5, { x: size.w / 2, y: size.h / 2 }, top))}>−</button>
        <button type="button" aria-label="The whole map" title="The whole map (0, Esc)" className="border-t border-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/10" onClick={() => setView(FIT_VIEW)}>fit</button>
      </div>
      {/* the legend: on its own panel over the map (labels and blocks pass under it), the colours on one row, the notes on the next */}
      <div className="pointer-events-none absolute right-2 bottom-1.5 z-10 flex max-w-[calc(100%-1rem)] flex-col items-end gap-0.5 rounded border border-white/10 bg-[#0b0f17]/95 px-2 py-1 text-[10px] whitespace-nowrap text-white/60">
        <div className="flex flex-wrap justify-end gap-x-2">
          <span><i className="mr-1 inline-block size-2 rounded-sm" style={{ background: KIND_COLORS.edit }} />editing</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm" style={{ background: KIND_COLORS.read }} />reading</span>
          <span><svg className="mr-1 inline-block align-middle" width={14} height={4} aria-hidden><line x1={0} y1={2} x2={14} y2={2} stroke={KIND_COLORS.claim} strokeWidth={2} strokeDasharray="4 2" /></svg>claimed</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm border border-white" style={{ background: KIND_COLORS.claim }} />claimed twice</span>
        </div>
        <div className="flex flex-wrap justify-end gap-x-2">
          <span>packages: commits</span>
          <span>· last {Math.round((SPARK_MS * SPARK_N) / 60_000)} min on the cards</span>
        </div>
      </div>
    </div>
  );
}
