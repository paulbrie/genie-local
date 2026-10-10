"use client";

import { ChevronDown, ChevronUp, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BUSY_MS, lastBefore, TASK_COLORS, type Snapshot, type Timeline } from "@/lib/agents3d-timeline";
import { TAG_COLORS } from "@/lib/comms-colors";

import type { Clock } from "./clock";
import type { Selection } from "./scene";

const HEAD_W = 168; // transport + track headers
const RULER_H = 22;
const ROW_H = 20;
const PAD = 4;
const ZOOM_H = 20;
const MIN_SPAN = 2 * 60_000;
const SPEEDS = [1, 10, 60, 300, 1200, 3600];
const TICK_STEPS = [
  60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000,
  12 * 3_600_000, 86_400_000,
];

type Hit =
  | { x0: number; x1: number; y0: number; y1: number; kind: "task"; key: string; text: string }
  | { x0: number; x1: number; y0: number; y1: number; kind: "agent"; key: string; text: string }
  | { x0: number; x1: number; y0: number; y1: number; kind: "message"; id: string; text: string }
  | { x0: number; x1: number; y0: number; y1: number; kind: "commit"; hash: string; text: string };

/** Busy stretches of one agent within [a, b]: runs of tool calls with gaps under `gap`. */
function busyRuns(ev: { ms: number }[], a: number, b: number, gap: number) {
  const runs: { s: number; e: number; n: number }[] = [];
  let i = Math.max(0, lastBefore(ev, a));
  for (; i < ev.length && ev[i].ms <= b; i++) {
    const t = ev[i].ms;
    const last = runs[runs.length - 1];
    if (last && t - last.e <= gap) {
      last.e = t;
      last.n++;
    } else runs.push({ s: t, e: t, n: 1 });
  }
  return runs;
}

function hatch(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = c.height = 6;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(239,68,68,0.9)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-1, 7);
  g.lineTo(7, -1);
  g.stroke();
  return ctx.createPattern(c, "repeat");
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(w, 1), h, rr);
}

const fmtTick = (ms: number, step: number) =>
  new Date(ms).toLocaleString(
    [],
    step >= 86_400_000 ? { weekday: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" },
  );

/**
 * A video-editor style timeline for Agents City: a ruler, a playhead, and one
 * track per agent with its task clips, a busy "waveform", message ticks and
 * commit keyframes. Click or drag to scrub; Ctrl/⌘+wheel zooms, wheel pans;
 * transport controls on the left; J/K/L keys. Drawn on a canvas at the
 * zoom's resolution.
 */
export function EditorTimeline({
  tl,
  snap,
  clock,
  hours,
  reduced,
  onSelect,
  onAgentClick,
  onOpen,
}: {
  tl: Timeline;
  snap: Snapshot;
  clock: Clock;
  hours: number;
  reduced: boolean;
  onSelect: (s: Selection) => void;
  onAgentClick: (key: string) => void;
  onOpen: (msgId: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [collapsed, setCollapsed] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const winSpan = hours * 3_600_000;
  const [span, setSpan] = useState(winSpan);
  // View: [end - span, end]. `follow` keeps the playhead in view (pinned right when live).
  const view = useRef({ end: 0, follow: true }); // end is set on the first frame
  const hits = useRef<Hit[]>([]);
  const drag = useRef<{ scrubbing: boolean } | null>(null);
  const pattern = useRef<CanvasPattern | null>(null);

  // A new window resets the zoom to the whole window.
  useEffect(() => {
    setSpan(winSpan); // eslint-disable-line react-hooks/set-state-in-effect
    view.current.follow = true;
  }, [winSpan]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - HEAD_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const agents = tl.agents;
  // The extra row at the bottom holds the zoom slider under the track headers.
  const height = collapsed ? RULER_H + 6 : RULER_H + PAD + agents.length * ROW_H + PAD + ZOOM_H;
  const winStart = Math.max(tl.start, tl.end - winSpan);

  // Static per-timeline data: task clips by worker.
  const taskClips = useMemo(() => {
    const out = new Map<string, { key: string; id: string | null; title: string; guessed: boolean; segs: { s: number; e: number | null; state: string }[] }[]>();
    for (const t of tl.tasks) {
      if (!tl.byKey.has(t.worker) || t.events.length === 0) continue;
      const segs: { s: number; e: number | null; state: string }[] = [];
      t.events.forEach((e, i) => {
        if (e.state === "done" || e.state === "cancelled") return;
        segs.push({ s: e.ms, e: i + 1 < t.events.length ? t.events[i + 1].ms : null, state: e.state });
      });
      if (segs.length === 0) continue;
      const list = out.get(t.worker) ?? [];
      list.push({ key: t.key, id: t.id, title: t.title, guessed: t.guessed, segs });
      out.set(t.worker, list);
    }
    return out;
  }, [tl]);

  // Draw loop.
  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    // What the last drawing showed (view to the pixel, playhead, its label): an unchanged one isn't redrawn.
    let lastKey = "";
    let lastSec = NaN;
    let label = "";
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // Reduced motion: redraw at ~4 Hz instead of every frame.
      if (reduced && now - lastDraw < 250) return;
      lastDraw = now;
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
        lastKey = ""; // resizing cleared it
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!pattern.current) pattern.current = hatch(ctx);

      const t = clock.now();
      const liveEnd = Math.max(Date.now(), tl.end);
      const v = view.current;
      const sp = Math.min(span, Math.max(liveEnd - winStart, MIN_SPAN));
      if (clock.live) v.end = liveEnd;
      else if (v.follow && (t > v.end - sp * 0.1 || t < v.end - sp)) v.end = Math.min(liveEnd, t + sp * 0.3);
      v.end = Math.min(Math.max(v.end, winStart + sp), liveEnd + sp * 0.02);
      const a = v.end - sp;
      const b = v.end;
      const X = (ms: number) => ((ms - a) / (b - a)) * width;
      if (Math.floor(t / 1000) !== lastSec) {
        lastSec = Math.floor(t / 1000);
        label = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }
      // Live, the view slides a pixel every span/width ms (seconds, on a wide window): draw then, not 60× a second.
      const key = `${Math.round((b / (b - a)) * width)}|${Math.round(X(t))}|${label}|${clock.live}`;
      if (key === lastKey) return;
      lastKey = key;
      const msPerPx = (b - a) / width;
      const H: Hit[] = [];

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#0b0f17";
      ctx.fillRect(0, 0, width, height);

      // Ruler ticks: the smallest step with labels ≥ 80 px apart.
      const step = TICK_STEPS.find((s) => s / msPerPx >= 80) ?? TICK_STEPS[TICK_STEPS.length - 1];
      const minor = step / (step >= 3_600_000 ? 6 : 5);
      const off = new Date(a).getTimezoneOffset() * 60_000;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      for (let ms = Math.ceil((a - off) / minor) * minor + off; ms <= b; ms += minor) {
        const x = Math.round(X(ms)) + 0.5;
        const major = Math.abs(((ms - off) % step + step) % step) < 1;
        ctx.strokeStyle = major ? "rgba(148,163,184,0.5)" : "rgba(148,163,184,0.2)";
        ctx.beginPath();
        ctx.moveTo(x, major ? RULER_H - 9 : RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = "rgba(203,213,225,0.75)";
          ctx.fillText(fmtTick(ms, step), x + 3, 8);
          if (!collapsed) {
            ctx.strokeStyle = "rgba(148,163,184,0.08)";
            ctx.beginPath();
            ctx.moveTo(x, RULER_H);
            ctx.lineTo(x, height);
            ctx.stroke();
          }
        }
      }
      ctx.strokeStyle = "rgba(148,163,184,0.25)";
      ctx.beginPath();
      ctx.moveTo(0, RULER_H + 0.5);
      ctx.lineTo(width, RULER_H + 0.5);
      ctx.stroke();
      // Outside the window: shaded.
      if (X(winStart) > 0) {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0, RULER_H, X(winStart), height - RULER_H);
      }

      if (!collapsed) {
        agents.forEach((ag, row) => {
          const y = RULER_H + PAD + row * ROW_H;
          if (row % 2) {
            ctx.fillStyle = "rgba(255,255,255,0.02)";
            ctx.fillRect(0, y, width, ROW_H);
          }
          // Busy "waveform" along the bottom of the row.
          const gap = Math.max(BUSY_MS, msPerPx * 3);
          for (const r of busyRuns(ag.events, a, b, gap)) {
            const x0 = X(r.s);
            const x1 = Math.max(X(r.e + Math.min(BUSY_MS, msPerPx * 2)), x0 + 2);
            const dens = Math.min(1, r.n / Math.max(1, (r.e - r.s) / 60_000 + 1) / 6);
            ctx.globalAlpha = 0.35 + dens * 0.55;
            ctx.fillStyle = ag.color;
            roundRect(ctx, x0, y + ROW_H - 7, x1 - x0, 5, 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            H.push({ x0, x1, y0: y + ROW_H - 8, y1: y + ROW_H, kind: "agent", key: ag.key, text: `${ag.name} · busy · ${r.n} tool calls` });
          }
          // Task clips.
          for (const clip of taskClips.get(ag.key) ?? []) {
            const x0c = X(clip.segs[0].s);
            const lastSeg = clip.segs[clip.segs.length - 1];
            const x1c = X(lastSeg.e ?? Math.max(t, lastSeg.s));
            if (x1c < 0 || x0c > width) continue;
            for (const sg of clip.segs) {
              const sx = X(sg.s);
              const ex = X(sg.e ?? Math.max(t, sg.s));
              if (ex < 0 || sx > width) continue;
              const col = TASK_COLORS[sg.state as keyof typeof TASK_COLORS] ?? "#64748b";
              ctx.globalAlpha = clip.guessed ? 0.35 : sg.state === "dispatched" ? 0.45 : 0.8;
              ctx.fillStyle = col;
              roundRect(ctx, sx, y + 2, ex - sx, ROW_H - 11, 3);
              ctx.fill();
              if (sg.state === "blocked" && pattern.current) {
                ctx.globalAlpha = 0.9;
                ctx.fillStyle = pattern.current;
                ctx.fill();
              }
              ctx.globalAlpha = 1;
            }
            ctx.strokeStyle = "rgba(0,0,0,0.5)";
            roundRect(ctx, x0c, y + 2, x1c - x0c, ROW_H - 11, 3);
            ctx.stroke();
            const label = `${clip.id ?? "·"} ${clip.title}`;
            const w = x1c - Math.max(x0c, 0) - 6;
            if (w > 18) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(Math.max(x0c, 0) + 3, y + 2, w, ROW_H - 11);
              ctx.clip();
              ctx.fillStyle = "rgba(255,255,255,0.92)";
              ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
              let text = label;
              while (text.length > 2 && ctx.measureText(text).width > w) text = text.slice(0, -2);
              if (text !== label) text = `${text.slice(0, -1)}…`;
              ctx.fillText(text, Math.max(x0c, 0) + 4, y + 2 + (ROW_H - 11) / 2);
              ctx.restore();
            }
            H.push({ x0: x0c, x1: x1c, y0: y + 2, y1: y + ROW_H - 9, kind: "task", key: clip.key, text: label });
          }
        });

        const rowOf = new Map(agents.map((ag, i) => [ag.key, i]));
        // Message ticks (on the sender's track, top edge), tag colour.
        for (let i = Math.max(0, lastBefore(tl.messages, a)); i < tl.messages.length && tl.messages[i].ms <= b; i++) {
          const m = tl.messages[i];
          const row = rowOf.get(m.from);
          if (row === undefined) continue;
          const x = X(m.ms);
          const y = RULER_H + PAD + row * ROW_H;
          ctx.fillStyle = m.color;
          ctx.fillRect(Math.round(x) - 1, y, 2, 6);
          H.push({ x0: x - 3, x1: x + 3, y0: y - 1, y1: y + 7, kind: "message", id: m.id, text: `${tl.byKey.get(m.from)?.name} → ${tl.byKey.get(m.to)?.name}: ${m.label}` });
        }
        // Commit / push keyframes (diamonds on the committer's track).
        for (const cm of tl.commits) {
          for (const [ms, pushed] of [[cm.ms, false], ...(cm.pushedMs != null ? [[cm.pushedMs, true]] : [])] as [number, boolean][]) {
            if (ms < a || ms > b) continue;
            const row = rowOf.get(cm.node);
            if (row === undefined) continue;
            const x = X(ms);
            const y = RULER_H + PAD + row * ROW_H + ROW_H / 2 - 3;
            ctx.fillStyle = pushed ? TAG_COLORS.PUSHED : TAG_COLORS.COMMIT;
            ctx.beginPath();
            ctx.moveTo(x, y - 4);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 4);
            ctx.lineTo(x - 4, y);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.stroke();
            H.push({ x0: x - 5, x1: x + 5, y0: y - 5, y1: y + 5, kind: "commit", hash: cm.hash, text: `${pushed ? "pushed" : "commit"} ${cm.abbrev} ${cm.subject ?? ""}` });
          }
        }
      }

      // Playhead.
      const px = Math.round(X(t)) + 0.5;
      ctx.strokeStyle = clock.live ? "#22c55e" : "#f8fafc";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 2);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = clock.live ? "#22c55e" : "#f8fafc";
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px + 5, 6);
      ctx.lineTo(px, 11);
      ctx.lineTo(px - 5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.font = "10px ui-monospace, monospace";
      const lw = ctx.measureText(label).width + 8;
      const lx = Math.min(Math.max(px + 7, 0), width - lw);
      ctx.fillStyle = "rgba(15,23,42,0.9)";
      roundRect(ctx, lx, 12, lw, 12, 3);
      ctx.fill();
      ctx.fillStyle = clock.live ? "#86efac" : "#f8fafc";
      ctx.fillText(label, lx + 4, 18);

      hits.current = H;
      viewRange.current = { a, b };
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tl, clock, width, height, span, winStart, collapsed, reduced, taskClips, agents]);

  const viewRange = useRef({ a: 0, b: 1 });
  const msAt = (x: number) => {
    const { a, b } = viewRange.current;
    return a + (x / width) * (b - a);
  };
  const hitAt = (x: number, y: number) => {
    for (let i = hits.current.length - 1; i >= 0; i--) {
      const h = hits.current[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  };
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const seek = (x: number) => {
    view.current.follow = false;
    clock.seek(Math.min(msAt(x), Math.max(Date.now(), tl.end)));
  };

  // Keys: J back 10% of the view, K play/pause, L play (again: faster). Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        clock.setPlaying(!clock.playing || clock.live);
      } else if (k === "l") {
        if (clock.playing && !clock.live) clock.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(clock.speed) + 1)] ?? clock.speed);
        clock.setPlaying(true);
      } else if (k === "j") {
        const { a, b } = viewRange.current;
        clock.seek(Math.max(clock.now() - (b - a) * 0.1, winStart));
      } else return;
      view.current.follow = true;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clock, winStart]);

  const zoomTo = (next: number, aroundX?: number) => {
    const s = Math.min(Math.max(next, MIN_SPAN), winSpan);
    if (aroundX !== undefined && !clock.live) {
      const at = msAt(aroundX);
      const f = aroundX / width;
      view.current.end = at + (1 - f) * s;
      view.current.follow = false;
    }
    setSpan(s);
  };

  const btn = "grid size-7 place-items-center rounded hover:bg-white/10 disabled:opacity-40";
  const live = clock.live;
  return (
    <div ref={wrap} className="relative flex select-none overflow-hidden rounded-md border border-white/10 bg-[#0b0f17] text-[11px] text-slate-300 shadow-lg">
      <div className="flex shrink-0 flex-col border-r border-white/10" style={{ width: HEAD_W }}>
        <div className="flex items-center gap-0.5 px-1" style={{ height: RULER_H + (collapsed ? 6 : PAD) }}>
          <button type="button" className={btn} title="Window start" onClick={() => { view.current.follow = true; clock.seek(winStart); }}>
            <SkipBack className="size-3.5" />
          </button>
          <button
            type="button"
            className={btn}
            title={live || !clock.playing ? "Play (K)" : "Pause (K)"}
            onClick={() => {
              if (live) clock.seek(Math.max(winStart, clock.now() - span * 0.5));
              clock.setPlaying(live ? true : !clock.playing);
              view.current.follow = true;
            }}
          >
            {!live && clock.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <button type="button" className={btn} title="Live" onClick={() => { view.current.follow = true; clock.goLive(); }}>
            <SkipForward className="size-3.5" />
          </button>
          <select
            aria-label="Replay speed"
            value={clock.speed}
            onChange={(e) => clock.setSpeed(Number(e.target.value))}
            className="h-6 rounded bg-white/5 px-1 text-[11px]"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s} className="bg-slate-900">
                {s}×
              </option>
            ))}
          </select>
          <span className={`ml-auto size-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-500"}`} title={live ? "Live" : "Replay"} />
          <button type="button" className={btn} title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
        {!collapsed &&
          agents.map((ag) => {
            const s = snap.agents.get(ag.key);
            return (
              <button
                key={ag.key}
                type="button"
                onClick={() => onAgentClick(ag.key)}
                title="Fly to this agent; click again to follow"
                className="flex items-center gap-1.5 truncate px-2 text-left hover:bg-white/5"
                style={{ height: ROW_H }}
              >
                <span className="size-2 shrink-0 rounded-sm" style={{ background: ag.color, boxShadow: s?.busy ? `0 0 6px ${ag.color}` : undefined }} />
                <span className="truncate">{ag.name}</span>
              </button>
            );
          })}
        {!collapsed && (
          <label className="mt-auto flex items-center gap-1 px-2 text-[10px] text-slate-400" style={{ height: ZOOM_H }} title="Zoom (Ctrl/⌘ + wheel)">
            zoom
            <input
              type="range"
              aria-label="Timeline zoom"
              min={0}
              max={1000}
              value={Math.round((1 - Math.log(span / MIN_SPAN) / Math.log(Math.max(winSpan / MIN_SPAN, 1.0001))) * 1000)}
              onChange={(e) => zoomTo(MIN_SPAN * Math.pow(winSpan / MIN_SPAN, 1 - Number(e.target.value) / 1000))}
              className="w-full accent-slate-300"
            />
          </label>
        )}
      </div>
      <canvas
        ref={canvas}
        style={{ width, height }}
        className="block cursor-crosshair touch-none"
        onPointerDown={(e) => {
          const { x, y } = local(e);
          const h = y > RULER_H ? hitAt(x, y) : null;
          if (h) {
            if (h.kind === "task") onSelect({ kind: "task", key: h.key });
            else if (h.kind === "agent") onAgentClick(h.key);
            else if (h.kind === "commit") onSelect({ kind: "commit", hash: h.hash });
            else onOpen(h.id);
            return;
          }
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { scrubbing: true };
          seek(x);
        }}
        onPointerMove={(e) => {
          const { x, y } = local(e);
          if (drag.current?.scrubbing) {
            seek(x);
            setTip(null);
            return;
          }
          const h = hitAt(x, y);
          setTip(h ? { x: x + HEAD_W, y, text: h.text } : null);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => setTip(null)}
        onWheel={(e) => {
          const { x } = local(e);
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoomTo(span * Math.pow(1.0015, e.deltaY), x);
          } else if (!clock.live) {
            // Pan: horizontal or vertical wheel.
            const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (span / width);
            view.current.end += d;
            view.current.follow = false;
          }
        }}
      />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-80 truncate rounded bg-black/90 px-2 py-1 text-[11px] text-white shadow"
          style={{ left: Math.min(tip.x + 10, HEAD_W + width - 220), top: Math.max(tip.y - 26, 0) }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}
