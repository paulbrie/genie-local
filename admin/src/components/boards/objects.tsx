"use client";

import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, Sparkles, X } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { BASE_PATH } from "@/lib/config";
import type { BoardDoc, BoardObject, Connector, ShapeKind } from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";

import { arrivalFrom, connectorPath, connectorPoints, penPath, sectionBarH } from "./geometry";
import { initials } from "./identity";

export type ObjectHandlers = {
  onText: (id: string, text: string, h?: number) => void;
  onToggleCollapse: (id: string) => void;
  onEditEnd: () => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
};

/** Sticky text shrinks as it grows, FigJam style. */
function stickyFont(text: string, w: number) {
  const n = text.length;
  const base = n < 30 ? 24 : n < 80 ? 19 : n < 160 ? 15 : n < 320 ? 13 : 11;
  return Math.max(9, base * (w / 200));
}

function EditableText({
  value,
  onChange,
  onDone,
  className,
  style,
  autoHeight,
  "data-fit": dataFit,
}: {
  value: string;
  onChange: (v: string, h?: number) => void;
  onDone: () => void;
  className?: string;
  style?: React.CSSProperties;
  autoHeight?: boolean;
  /** Marks the element Fit measures, so it works while editing too. */
  "data-fit"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (autoHeight && el) {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value, autoHeight]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => {
        const el = e.currentTarget;
        let h: number | undefined;
        if (autoHeight) {
          el.style.height = "0px";
          h = el.scrollHeight;
          el.style.height = `${h}px`;
        }
        onChange(el.value, h);
      }}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      spellCheck
      className={cn("block w-full resize-none border-0 bg-transparent p-0 outline-none", className)}
      style={style}
      data-fit={dataFit}
    />
  );
}

function ShapeSvg({ kind, w, h, fill, stroke }: { kind: ShapeKind; w: number; h: number; fill: string; stroke: string }) {
  const sw = 2;
  const p = sw / 2;
  let el: React.ReactNode;
  switch (kind) {
    case "ellipse":
      el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} />;
      break;
    case "diamond":
      el = <polygon points={`${w / 2},${p} ${w - p},${h / 2} ${w / 2},${h - p} ${p},${h / 2}`} />;
      break;
    case "triangle":
      el = <polygon points={`${w / 2},${p} ${w - p},${h - p} ${p},${h - p}`} />;
      break;
    case "roundrect":
      el = <rect x={p} y={p} width={w - sw} height={h - sw} rx={Math.min(24, h / 3)} />;
      break;
    default:
      el = <rect x={p} y={p} width={w - sw} height={h - sw} rx={3} />;
  }
  return (
    <svg className="absolute inset-0 overflow-visible" width={w} height={h} fill={fill} stroke={stroke} strokeWidth={sw}>
      {el}
    </svg>
  );
}

function arrowHead(tip: { x: number; y: number }, from: { x: number; y: number }, size: number) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const l = { x: tip.x - size * Math.cos(a - 0.45), y: tip.y - size * Math.sin(a - 0.45) };
  const r = { x: tip.x - size * Math.cos(a + 0.45), y: tip.y - size * Math.sin(a + 0.45) };
  return `${tip.x},${tip.y} ${l.x},${l.y} ${r.x},${r.y}`;
}

export function ConnectorView({ doc, o, preview }: { doc: BoardDoc; o: Connector; preview?: boolean }) {
  const { a, b, da, db } = connectorPoints(doc, o);
  // A curve's label rides its middle, which is not the midpoint of the ends.
  const { atB, atA } = arrivalFrom(a, b, da, db, o.curved);
  const mid = o.curved
    ? { x: (a.x + b.x) / 2 * 0.5 + (atA.x + atB.x) / 2 * 0.5, y: (a.y + b.y) / 2 * 0.5 + (atA.y + atB.y) / 2 * 0.5 }
    : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ zIndex: o.z }}>
        <path
          d={connectorPath(a, b, da, db, o.curved)}
          fill="none"
          stroke={o.color}
          strokeWidth={2}
          strokeDasharray={o.dashed || preview ? "8 6" : undefined}
          strokeLinecap="round"
        />
        {(o.arrow === "end" || o.arrow === "both") && <polygon points={arrowHead(b, atB, 12)} fill={o.color} />}
        {o.arrow === "both" && <polygon points={arrowHead(a, atA, 12)} fill={o.color} />}
      </svg>
      {o.label && (
        <div
          className="pointer-events-none absolute whitespace-nowrap rounded bg-background px-1.5 py-0.5 text-xs text-foreground shadow-sm ring-1 ring-border"
          style={{ left: mid.x, top: mid.y, transform: "translate(-50%,-50%)", zIndex: o.z }}
        >
          {o.label}
        </div>
      )}
    </>
  );
}

function VoteBadge({ votes, me }: { votes?: Record<string, number>; me: string }) {
  if (!votes) return null;
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const mine = votes[me] ?? 0;
  return (
    <div
      className={cn(
        "absolute -right-2.5 -top-2.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold shadow",
        mine ? "bg-violet-600 text-white" : "bg-zinc-800 text-white",
      )}
      title={mine ? `${total} votes (${mine} yours)` : `${total} votes`}
    >
      {total}
    </div>
  );
}

function SuggestionBar({ id, h }: { id: string; h: ObjectHandlers }) {
  return (
    <div
      className="absolute -top-8 left-0 flex items-center gap-1 whitespace-nowrap rounded-full bg-[#d97757] py-0.5 pl-2 pr-0.5 text-[11px] font-medium text-white shadow"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Sparkles className="size-3" /> Claude suggests
      <button className="ml-1 rounded-full bg-white/20 p-0.5 hover:bg-white/35" title="Keep it" onClick={() => h.onAccept(id)}>
        <Check className="size-3.5" />
      </button>
      <button className="rounded-full bg-white/20 p-0.5 hover:bg-white/35" title="Dismiss" onClick={() => h.onDismiss(id)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

type Props = {
  o: BoardObject;
  editing: boolean;
  me: string;
  handlers: ObjectHandlers;
  /** How many things a folded section is hiding. */
  hiddenCount?: number;
  /** Selected: its links become clickable (otherwise a click just picks it up). */
  selected?: boolean;
  /** Someone else is typing in it (their colour). */
  lockedBy?: string;
};

/** One board object in world coordinates (connectors render via ConnectorView). */
/**
 * Defang link targets a board shouldn't open: anything that isn't http(s),
 * mailto or a plain path — `javascript:` above all. Board text is written by
 * whoever is on the board and by Claude pasting from the web, so this guards at
 * the source rather than trusting whichever renderer is downstream.
 */
function safeMarkdown(text: string): string {
  // The target, allowing one level of brackets inside it (…(1)…), plus an
  // optional "title" after it.
  return text.replace(/\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)([^()]*)\)/g, (whole, target: string, title: string) => {
    const t = target.trim();
    const ok = t === "" || /^(https?:\/\/|mailto:)/i.test(t) || /^(\/|\.{1,2}\/|#)/.test(t);
    return ok ? whole : `](#${title.trim() ? ` ${title.trim()}` : ""})`;
  });
}

/** The address, when the whole of the text is one http(s) link and nothing else. */
function soleUrl(text: string): URL | null {
  const t = text.trim();
  if (/\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Nothing but a link: show it as a card rather than a line of blue text, so a
 * pasted address reads as the thing it points at.
 */
function LinkCard({ url, selected }: { url: URL; selected?: boolean }) {
  const rest = `${url.pathname}${url.search}`.replace(/\/$/, "");
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex items-center gap-2 rounded-md bg-black/5 px-2 py-1.5 text-left no-underline",
        selected ? "pointer-events-auto hover:bg-black/10" : "pointer-events-none",
      )}
      title={url.href}
    >
      <ExternalLink className="size-[1.1em] shrink-0 opacity-60" />
      <span className="min-w-0">
        <span className="block truncate font-semibold">{url.host.replace(/^www\./, "")}</span>
        {rest && rest !== "/" && <span className="block truncate text-[0.8em] opacity-60">{rest}</span>}
      </span>
    </a>
  );
}

/**
 * The shared markdown renderer sizes its blocks for documents (paragraphs at
 * text-sm and so on), which would ignore the size set on a sticky or a text box.
 * On a board everything is relative to the object's own font size instead, so
 * headings still stand out and the size control means something. Margins are
 * tightened to suit a sticky rather than a page.
 */
const BOARD_TEXT = [
  "[&_p]:text-[length:1em] [&_ul]:text-[length:1em] [&_ol]:text-[length:1em] [&_li]:text-[length:1em]",
  "[&_h1]:text-[length:1.6em] [&_h2]:text-[length:1.35em] [&_h3]:text-[length:1.15em]",
  "[&_h4]:text-[length:1em] [&_h5]:text-[length:1em] [&_h6]:text-[length:1em]",
  "[&_table]:text-[length:0.9em] [&_pre]:text-[length:0.85em] [&_code]:text-[length:0.9em]",
  "[&_p]:my-[0.3em] [&_ul]:my-[0.3em] [&_ol]:my-[0.3em] [&_pre]:my-[0.4em]",
  "[&_h1]:mb-[0.3em] [&_h1]:mt-0 [&_h2]:mb-[0.25em] [&_h2]:mt-[0.4em] [&_h3]:mb-[0.2em] [&_h3]:mt-[0.35em]",
  "[&>*>*:first-child]:mt-0 [&>*>*:last-child]:mb-0",
].join(" ");

/**
 * Written text as Markdown — tables, links, lists, code. Links only answer the
 * pointer once the thing they're on is selected, so dragging a sticky around
 * doesn't keep opening tabs.
 */
function Body({ text, className, selected }: { text: string; className?: string; selected?: boolean }) {
  const url = soleUrl(text);
  if (url) return <LinkCard url={url} selected={selected} />;
  const source = safeMarkdown(text);
  return (
    <div className={cn("pointer-events-none", BOARD_TEXT, selected && "[&_a]:pointer-events-auto")}>
      <Markdown source={source} breaks className={cn("space-y-1", className)} />
    </div>
  );
}

export const ObjectView = memo(function ObjectView({ o, editing, me, handlers, lockedBy, hiddenCount = 0, selected }: Props) {
  const box: React.CSSProperties = { left: o.x, top: o.y, width: o.w, height: o.h, zIndex: o.z };
  const ring = lockedBy ? { boxShadow: `0 0 0 2px ${lockedBy}` } : undefined;
  const suggestion = o.suggestion ? <SuggestionBar id={o.id} h={handlers} /> : null;
  const suggestStyle = o.suggestion ? "outline-2 outline-dashed outline-[#d97757] outline-offset-4" : "";

  switch (o.type) {
    case "sticky": {
      const fs = stickyFont(o.text, o.w);
      return (
        <div className={cn("absolute select-none", suggestStyle)} style={{ ...box, ...ring }}>
          {suggestion}
          <div
            className="flex h-full w-full flex-col justify-center overflow-hidden p-4 text-zinc-900 shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            style={{ background: o.color }}
          >
            {editing ? (
              <EditableText
                value={o.text}
                onChange={(t) => handlers.onText(o.id, t)}
                onDone={handlers.onEditEnd}
                className="text-center leading-snug"
                style={{ fontSize: fs, height: "100%" }}
              />
            ) : (
              <div className="break-words text-center leading-snug" style={{ fontSize: fs }}>
                <Body text={o.text} className="text-zinc-900" selected={selected} />
              </div>
            )}
          </div>
          {o.author && (
            <div className="pointer-events-none absolute bottom-1.5 left-3 max-w-[85%] truncate text-[10px] text-zinc-900/45">
              {o.author.name}
            </div>
          )}
          <VoteBadge votes={o.votes} me={me} />
        </div>
      );
    }
    case "text":
      return (
        <div className={cn("absolute select-none", suggestStyle)} style={{ ...box, height: "auto", minHeight: o.h, ...ring }}>
          {suggestion}
          {editing ? (
            <EditableText
              value={o.text}
              autoHeight
              data-fit={o.id}
              onChange={(t, h) => handlers.onText(o.id, t, h)}
              onDone={handlers.onEditEnd}
              className="leading-tight"
              style={{ fontSize: o.fontSize, color: o.color }}
            />
          ) : (
            <div className="break-words leading-tight" data-fit={o.id} style={{ fontSize: o.fontSize, color: o.color }}>
              {o.text ? <Body text={o.text} className="text-inherit" selected={selected} /> : <span className="opacity-40">Text</span>}
            </div>
          )}
          <VoteBadge votes={o.votes} me={me} />
        </div>
      );
    case "shape":
      return (
        <div className={cn("absolute select-none", suggestStyle)} style={{ ...box, ...ring }}>
          {suggestion}
          <ShapeSvg kind={o.shape} w={o.w} h={o.h} fill={o.color} stroke={o.stroke} />
          <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-zinc-900">
            {editing ? (
              <EditableText
                value={o.text}
                onChange={(t) => handlers.onText(o.id, t)}
                onDone={handlers.onEditEnd}
                className="text-center"
                style={{ fontSize: 15 }}
              />
            ) : (
              <div className="break-words" style={{ fontSize: 15 }}>
                <Body text={o.text} className="text-zinc-900" selected={selected} />
              </div>
            )}
          </div>
          <VoteBadge votes={o.votes} me={me} />
        </div>
      );
    case "section": {
      const Chevron = o.collapsed ? ChevronRight : ChevronDown;
      const fold = (
        <button
          className="shrink-0 rounded p-0.5 hover:bg-black/10"
          title={o.collapsed ? "Unfold this section" : "Fold this section"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => handlers.onToggleCollapse(o.id)}
        >
          <Chevron className="size-4" />
        </button>
      );
      const titleText = editing ? (
        <EditableText
          value={o.title}
          onChange={(t) => handlers.onText(o.id, t)}
          onDone={handlers.onEditEnd}
          style={{ fontSize: o.fontSize, height: o.fontSize * 1.3 }}
        />
      ) : (
        <span className="truncate">{o.title || "Section"}</span>
      );

      if (o.collapsed) {
        return (
          <div className="absolute select-none" style={{ ...box, height: sectionBarH(o), ...ring }}>
            {suggestion}
            <div
              className="flex h-full w-full items-center gap-1.5 rounded-md border border-black/10 px-2 font-semibold text-zinc-800"
              style={{ background: o.color, fontSize: o.fontSize }}
            >
              {fold}
              {titleText}
              {hiddenCount > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-black/10 px-1.5 text-[11px] font-medium">
                  {hiddenCount}
                </span>
              )}
            </div>
            <VoteBadge votes={o.votes} me={me} />
          </div>
        );
      }

      return (
        <div className="absolute" style={{ ...box, ...ring }}>
          <div
            className="absolute left-0 flex items-center gap-1 truncate rounded-t-md px-1.5 py-1 font-semibold text-zinc-800"
            style={{
              background: o.color,
              minWidth: 60,
              maxWidth: Math.max(260, o.w),
              fontSize: o.fontSize,
              top: -(o.fontSize * 1.1 + 12),
            }}
          >
            {fold}
            {titleText}
          </div>
          <div className="h-full w-full rounded-md rounded-tl-none border border-black/10" style={{ background: o.color }} />
          <VoteBadge votes={o.votes} me={me} />
        </div>
      );
    }
    case "pen":
      return (
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{ left: o.x, top: o.y, zIndex: o.z }}
          width={Math.max(1, o.w)}
          height={Math.max(1, o.h)}
        >
          <path d={penPath(o.points)} fill="none" stroke={o.color} strokeWidth={o.width} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "image":
      return (
        <div className="absolute select-none" style={{ ...box, ...ring }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}${o.src}`} alt={o.alt} draggable={false} className="h-full w-full rounded-sm object-fill shadow" />
          <VoteBadge votes={o.votes} me={me} />
        </div>
      );
    case "comment": {
      const first = o.thread[0];
      const who = first?.author;
      return (
        <div className={cn("absolute select-none", suggestStyle)} style={{ left: o.x, top: o.y, zIndex: 1e9 - 1 }}>
          {suggestion}
          <div
            className={cn(
              "flex size-8 items-center justify-center rounded-full rounded-bl-none text-xs font-semibold text-white shadow-md ring-2 ring-white",
              o.resolved && "opacity-45",
            )}
            style={{ background: who?.color ?? "#71717a" }}
            title={first ? `${who?.name}: ${first.text}` : "Comment"}
          >
            {who ? initials(who.name) : "?"}
          </div>
          {o.thread.length > 1 && (
            <div className="absolute -right-2 -top-2 rounded-full bg-zinc-900 px-1.5 text-[10px] font-semibold text-white">
              {o.thread.length}
            </div>
          )}
        </div>
      );
    }
    default:
      return null;
  }
});
