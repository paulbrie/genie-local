"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CommsMessage } from "@/lib/claude-comms-parse";

import type { NodeView } from "./comms-view";

const GUTTER = 64;
const MIN_COL = 150;
const ROW_H = 40;
const GAP_H = 22;
const DAY_H = 26;
const PAGE = 400;
/** A pause longer than this gets a "… later" marker row. */
const GAP_MS = 30 * 60_000;

type Row =
  | { kind: "day"; label: string; y: number }
  | { kind: "gap"; label: string; y: number }
  | { kind: "msg"; m: CommsMessage; y: number };

const at = (m: CommsMessage) => m.sentAt ?? m.receivedAt;

function hhmm(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function gapLabel(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 24 ? `${Math.round(h / 24)}d later` : h >= 1 ? `${Math.round(h)}h later` : `${Math.round(ms / 60_000)}m later`;
}

export function label(m: CommsMessage): string {
  const tag = m.tags[0];
  const head = tag ? `${tag.tag} ${tag.arg.split(/\s+/)[0] ?? ""}`.trim() : "";
  const text = m.summary ?? (tag ? tag.arg.split(/\s+/).slice(1).join(" ") : "");
  const fallback = m.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  const rest = text || fallback;
  return head ? `${head}${rest ? ` · ${rest}` : ""}` : rest;
}

export function SequenceDiagram({
  nodes,
  byKey,
  messages,
  highlight,
  onOpen,
}: {
  nodes: NodeView[];
  byKey: Map<string, NodeView>;
  messages: CommsMessage[];
  highlight: Set<string> | null;
  onOpen: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [limit, setLimit] = useState(PAGE);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = messages.length > limit ? messages.slice(-limit) : messages;
  const col = Math.max(MIN_COL, (width - GUTTER) / Math.max(nodes.length, 1));
  const svgW = GUTTER + col * nodes.length;
  const xOf = useMemo(() => {
    const idx = new Map(nodes.map((n, i) => [n.key, i]));
    return (key: string) => GUTTER + col * (idx.get(key) ?? 0) + col / 2;
  }, [nodes, col]);

  const { rows, height } = useMemo(() => {
    const out: Row[] = [];
    let y = 8;
    let prevDay = "";
    let prevT = 0;
    for (const m of shown) {
      const iso = at(m);
      const t = iso ? Date.parse(iso) : prevT;
      const day = iso ? new Date(iso).toDateString() : prevDay;
      if (day !== prevDay) {
        out.push({ kind: "day", label: new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }), y });
        y += DAY_H;
      } else if (prevT && t - prevT > GAP_MS) {
        out.push({ kind: "gap", label: gapLabel(t - prevT), y });
        y += GAP_H;
      }
      out.push({ kind: "msg", m, y });
      y += ROW_H;
      prevDay = day;
      prevT = t;
    }
    return { rows: out, height: y + 8 };
  }, [shown]);

  // Follow new messages while scrolled to the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  if (nodes.length === 0)
    return (
      <div className="grid place-items-center rounded-md border p-10 text-sm text-muted-foreground">
        Every session is hidden. Click a session name above to show it.
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded-md border">
      {/* Lifeline heads */}
      <div className="overflow-hidden border-b bg-muted/30">
        <div className="flex" style={{ width: svgW, paddingLeft: GUTTER }}>
          {nodes.map((n) => (
            <div key={n.key} className="truncate px-2 py-1.5 text-center" style={{ width: col }}>
              <div className="flex items-center justify-center gap-1.5 text-sm font-medium">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: n.color }} />
                <span className="truncate">{n.name}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {n.role} · {n.shortId}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        ref={scroller}
        className="max-h-[70vh] min-h-64 overflow-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          const head = el.previousElementSibling as HTMLElement | null;
          if (head) head.scrollLeft = el.scrollLeft;
        }}
      >
        {messages.length > shown.length && (
          <div className="p-2 text-center">
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setLimit(limit + PAGE)}
            >
              Show {Math.min(PAGE, messages.length - shown.length)} earlier messages
            </button>
          </div>
        )}
        <svg width={svgW} height={height} className="block select-none">
          <defs>
            {nodes.map((n) => (
              <marker
                key={n.key}
                id={`arrow-${cssId(n.key)}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill={n.color} />
              </marker>
            ))}
          </defs>

          {nodes.map((n) => (
            <line
              key={n.key}
              x1={xOf(n.key)}
              x2={xOf(n.key)}
              y1={0}
              y2={height}
              stroke="var(--border)"
              strokeDasharray="4 4"
            />
          ))}

          {rows.map((r, i) => {
            if (r.kind === "day")
              return (
                <g key={`d${i}`}>
                  <line x1={0} x2={svgW} y1={r.y + DAY_H / 2} y2={r.y + DAY_H / 2} stroke="var(--border)" />
                  <text x={8} y={r.y + DAY_H / 2 - 4} className="fill-muted-foreground text-[10px] font-medium">
                    {r.label}
                  </text>
                </g>
              );
            if (r.kind === "gap")
              return (
                <text key={`g${i}`} x={8} y={r.y + GAP_H / 2 + 3} className="fill-muted-foreground text-[10px] italic">
                  … {r.label}
                </text>
              );
            const m = r.m;
            const from = byKey.get(m.from);
            const x1 = xOf(m.from);
            const x2 = xOf(m.to);
            const dir = x2 >= x1 ? 1 : -1;
            const y = r.y + ROW_H - 12;
            const dim = highlight && !highlight.has(m.id);
            const failed = m.state === "failed";
            const pending = m.state === "queued" || m.state === "sending";
            const span = Math.abs(x2 - x1);
            const maxChars = Math.max(8, Math.floor((span - 12) / 6.2));
            const text = label(m);
            const shownText = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
            return (
              <g
                key={m.id}
                className="cursor-pointer"
                opacity={dim ? 0.25 : 1}
                onClick={() => onOpen(m.id)}
              >
                <title>{`${from?.name ?? "?"} → ${byKey.get(m.to)?.name ?? "?"} · ${m.state}\n${text}`}</title>
                <rect x={0} y={r.y} width={svgW} height={ROW_H} className="fill-transparent hover:fill-muted/60" />
                <text x={GUTTER - 8} y={y + 3} textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                  {hhmm(at(m))}
                </text>
                <line
                  x1={x1 + dir * 4}
                  x2={x2 - dir * 4}
                  y1={y}
                  y2={y}
                  stroke={failed ? "var(--destructive)" : (from?.color ?? "currentColor")}
                  strokeWidth={1.75}
                  strokeDasharray={pending || failed ? "5 4" : undefined}
                  markerEnd={`url(#arrow-${cssId(m.from)})`}
                />
                <circle cx={x1} cy={y} r={3} fill={from?.color ?? "currentColor"} />
                <text
                  x={(x1 + x2) / 2}
                  y={y - 7}
                  textAnchor="middle"
                  className={`text-[11px] ${failed ? "fill-destructive" : "fill-foreground"}`}
                >
                  {failed ? "✕ " : ""}
                  {shownText}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>— delivered / read</span>
        <span>- - queued, not read yet</span>
        <span className="text-destructive">- - ✕ failed</span>
        <span>Click a row for the full message.</span>
      </div>
    </div>
  );
}

function cssId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}
