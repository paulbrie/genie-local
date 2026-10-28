"use client";

import { useEffect, useRef, useState } from "react";
import { Download, File as FileIcon, FileLock, Maximize2, Minimize2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { downloadFile, type Entry } from "./files-api";
import { FileViewer } from "./file-viewer";

type Geom = { x: number; y: number; w: number; h: number };
/** the window's first size, and the least it resizes to (or the viewport, when that is smaller) */
const DEFAULT_SIZE = { w: 760, h: 540 }, MIN_SIZE = { w: 360, h: 240 };
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });
/**
 * the n-th window opened, a step down and left of the one before (and round again after eight): from the right, so the
 * listing's names stay in view
 */
const cascade = (index: number, vw: number) => ({ x: Math.max(0, vw - DEFAULT_SIZE.w - 48 - (index % 8) * 32), y: 90 + (index % 8) * 32 });
/** a window inside a `vw` × `vh` viewport: no bigger than it, no smaller than the minimum, wholly on screen */
function clampGeom(g: Geom, vw: number, vh: number): Geom {
  const w = Math.round(Math.max(Math.min(MIN_SIZE.w, vw), Math.min(g.w, vw)));
  const h = Math.round(Math.max(Math.min(MIN_SIZE.h, vh), Math.min(g.h, vh)));
  return { x: Math.round(Math.min(Math.max(0, g.x), vw - w)), y: Math.round(Math.min(Math.max(0, g.y), vh - h)), w, h };
}
/** `start` resized by its `edge` dragged (dx, dy): the opposite edges stay put, down to the minimum size and the viewport's sides */
function resizeGeom(start: Geom, edge: Edge, dx: number, dy: number, vw: number, vh: number): Geom {
  let { x, y, w, h } = start;
  const right = start.x + start.w, bottom = start.y + start.h;
  if (edge.includes("e")) w = Math.min(vw - x, Math.max(MIN_SIZE.w, start.w + dx));
  if (edge.includes("s")) h = Math.min(vh - y, Math.max(MIN_SIZE.h, start.h + dy));
  if (edge.includes("w")) { x = Math.max(0, Math.min(right - MIN_SIZE.w, start.x + dx)); w = right - x; }
  if (edge.includes("n")) { y = Math.max(0, Math.min(bottom - MIN_SIZE.h, start.y + dy)); h = bottom - y; }
  return { x, y, w, h };
}
// (the grab strips, astride the window's border: edges 8px wide, corners 16px square, outside the rounded clip)
const EDGES: { edge: Edge; className: string }[] = [
  { edge: "n", className: "inset-x-3 -top-1 h-2 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edge: "e", className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edge: "w", className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edge: "nw", className: "-top-1 -left-1 size-4 cursor-nwse-resize" },
  { edge: "se", className: "-right-1 -bottom-1 size-4 cursor-nwse-resize" },
  { edge: "ne", className: "-top-1 -right-1 size-4 cursor-nesw-resize" },
  { edge: "sw", className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
];

/**
 * A file of the explorer in its own window (FileViewer inside): moved by its title bar, resized from any edge or corner,
 * kept inside the browser window (and refitted when that resizes), maximized and restored (the button, or a double-click
 * on the title), raised by a click, closed with × or Escape while it has the focus. Several open at once, cascaded
 * (`index`); the explorer keeps their stacking (`z`, `active` = the frontmost), asks about unsaved changes before one
 * closes (`onClose`), and focuses one again (`focusTick`) when its file is opened again. Full-screen on phones (`mobile`).
 * Drawn the way the terminal and run docks draw theirs: fixed, pointer listeners on the window during a drag.
 */
export function FileWindow({ entry, scope, project, index, z, active, focusTick, mobile, dirty, onRaise, onClose, onDirty, onSaved }: {
  entry: Entry;
  scope: string;
  project?: string;
  index: number;
  z: number;
  active: boolean;
  focusTick: number;
  mobile: boolean;
  dirty: boolean;
  onRaise: () => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onSaved: (r: { size: number; mtime: number }) => void;
}) {
  // `wanted` is where the user last put the window, drawn fitted to the viewport (`geom`)
  const [wanted, setWanted] = useState<Geom>(() => ({ ...cascade(index, window.innerWidth), ...DEFAULT_SIZE }));
  const [vp, setVp] = useState(viewport);
  const [maximized, setMaximized] = useState(false);
  const [moving, setMoving] = useState(false);
  const geom = maximized ? { x: 0, y: 0, ...vp } : clampGeom(wanted, vp.w, vp.h);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setVp(viewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // (opened, or its file opened again: the focus, so Escape and the keys go to it)
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, [focusTick]);

  /** follows the pointer until it's let go: `to` turns the pointer's travel into the window's new box */
  const track = (e: React.PointerEvent, to: (dx: number, dy: number, v: { w: number; h: number }) => Geom) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onRaise();
    const x0 = e.clientX, y0 = e.clientY;
    // (captured, so an iframe or Monaco under the pointer doesn't swallow the moves)
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setMoving(true);
    const move = (ev: PointerEvent) => setWanted(to(ev.clientX - x0, ev.clientY - y0, viewport()));
    const up = () => {
      setMoving(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  function onTitlePointerDown(e: React.PointerEvent) {
    if (mobile || maximized || (e.target as HTMLElement).closest("button, a, input")) return;
    const start = geom;
    track(e, (dx, dy, v) => clampGeom({ ...start, x: start.x + dx, y: start.y + dy }, v.w, v.h));
  }
  function onEdgePointerDown(e: React.PointerEvent, edge: Edge) {
    const start = geom;
    track(e, (dx, dy, v) => resizeGeom(start, edge, dx, dy, v.w, v.h));
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`File ${entry.name}`}
      tabIndex={-1}
      onPointerDown={onRaise}
      onFocus={onRaise}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
      style={mobile ? { zIndex: z } : { left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex: z }}
      data-testid="file-window"
      className={cn("fixed outline-none", mobile && "inset-0")}
    >
      <div
        className={cn(
          "flex h-full flex-col overflow-hidden bg-background",
          !mobile && cn("border transition-shadow", !maximized && "rounded-lg"),
          !mobile && (active ? "shadow-[0_0_30px_-4px] shadow-primary/40 ring-1 ring-primary/30" : "shadow-2xl ring-1 ring-foreground/10"),
        )}
      >
        <div
          onPointerDown={onTitlePointerDown}
          onDoubleClick={(e) => { if (!mobile && !(e.target as HTMLElement).closest("button")) setMaximized((m) => !m); }}
          className={cn("flex items-center gap-1.5 border-b bg-muted/60 px-2.5 py-1.5 select-none", !mobile && !maximized && "cursor-move")}
        >
          {entry.secret ? <FileLock className="size-4 shrink-0 text-rose-500" /> : <FileIcon className="size-4 shrink-0 opacity-70" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.path}>
            {entry.name}{dirty && <span className="ml-1.5 text-amber-500" title="Unsaved changes" aria-label="Unsaved changes">●</span>}
          </span>
          <button type="button" onClick={() => void downloadFile(scope, entry)} aria-label={`Download ${entry.name}`} title="Download" className="rounded p-1 opacity-70 hover:bg-muted hover:opacity-100">
            <Download className="size-4" />
          </button>
          {!mobile && (
            <button type="button" onClick={() => setMaximized((m) => !m)} aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} className="rounded p-1 opacity-70 hover:bg-muted hover:opacity-100">
              {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close window" title="Close (Esc)" className="rounded p-1 opacity-70 hover:bg-muted hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>
        {/* (while it moves, the pointer belongs to the window, not to the editor or a PDF under it) */}
        <div className={cn("min-h-0 flex-1", moving && "pointer-events-none select-none")}>
          <FileViewer entry={entry} scope={scope} project={project} active={active} onDirty={onDirty} onSaved={onSaved} />
        </div>
      </div>
      {!mobile && !maximized && EDGES.map(({ edge, className }) => (
        <div key={edge} aria-hidden onPointerDown={(e) => onEdgePointerDown(e, edge)} className={cn("absolute z-10 touch-none", className)} />
      ))}
    </div>
  );
}
