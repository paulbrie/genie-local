"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  Check,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Minimize2,
  Minus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import { WISP_BODY, WISP_EYES } from "@/brand/spiridus";
import { AppIcon, LaunchpadIcon, ProjectIcon, VsCodeIcon } from "@/components/desktop/app-icon";
import { openSettings, sortIconsByName } from "@/components/desktop/desktop-menu";
import { WIDGET_BODY, WIDGET_ICON } from "@/components/desktop/widget-registry";
import { NAV_FLAT, NAV_HREFS, type NavItem } from "@/components/nav-items";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import {
  appOf,
  type Cell,
  type CellRect,
  cellsRect,
  clampRect,
  defaultGeom,
  alignShift,
  defaultWidgetAt,
  type DeskAlign,
  type DeskSaved,
  DOCK_ICON,
  dropRange,
  dockSpace,
  type Edges,
  fitShift,
  ICON_GRID,
  iconGridSize,
  layoutIcons,
  maxRect,
  moveCells,
  moveIcon,
  overlaps,
  placeWidgets,
  arrangementFits,
  stackDesktop,
  widgetWants,
  type Rect,
  resizeCells,
  resizeRect,
  subPath,
  unmaximizeUnder,
  VSCODE_ICON,
  WIDGET_LABEL,
  WIDGET_MIN,
  type WidgetId,
  widgetMode,
  WIDGETS,
} from "@/lib/desktop";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useNavBadges } from "@/lib/use-nav-badges";
import { Z_LAUNCHPAD } from "@/lib/z-layers";
import { openTerminal } from "@/store/terminals";
import { commandPalette } from "@/store/ui";
import {
  closeApp,
  desk,
  deskView,
  hydrateDesk,
  launchpad,
  noteApp,
  minimizeWindow,
  openApps,
  setGeom,
  setArrangement,
  setDockSize,
  setIcons,
  setOnDesktop,
  setWidgetAt,
  setWidgetMode,
  closeFrame,
  deskDrag,
  focusWin,
  frames,
  frontWin,
  MAIN_WIN,
  openAppWindow,
  openFrame,
  stack,
  updateFrame,
  type FrameWin,
  setPinned,
  showWindow,
} from "@/store/desktop";

const BY_HREF = new Map(NAV_FLAT.map((i) => [i.href, i]));

type BadgeOf = (href: string) => number | null;

/**
 * Where the page goes, in either interface. Classic: the scrolling column next
 * to the sidebar. Desktop: a wallpaper with every app as an icon, the page in a
 * window over it (drag it by its title bar, resize it from any edge, maximize,
 * minimize to the dock, close), and a dock of pinned and open apps.
 *
 * The page sits at the same place in the tree in both, so switching interfaces
 * doesn't remount it (the extra wrappers are `display: contents` in classic).
 * The window has no transform or filter: a page's own `fixed` panels stay
 * relative to the viewport. Alone, it has no z-index either, so the page's
 * z-indexes work against the rest of the app as they do in classic; with other
 * windows open it's a layer at its place among them (winZ), so nothing in it
 * shows through the windows in front (dialogs and menus are portalled out).
 */
export function Workspace({ desktop, children }: { desktop: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mobile = useIsMobile();
  const areaRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const [ws, setWs] = useState<{ w: number; h: number } | null>(null);
  const [{ geoms, dockSize }] = useSubject(desk);
  const dock = dockSpace(dockSize);
  const [{ hidden }] = useSubject(deskView);
  const [others] = useSubject(frames);
  const [order] = useSubject(stack);
  // the rect while it's being dragged or resized (saved on release)
  const [live, setLive] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  // animate left/top/width/height for a moment (maximize / restore)
  const [glide, setGlide] = useState(false);
  const [anim, setAnim] = useState<"in" | "out" | null>("in");
  const { badgeOf } = useNavBadges(pathname, desktop);

  const app = appOf(pathname, NAV_HREFS);
  const item = app ? (BY_HREF.get(app) ?? null) : null;
  // a page outside every app keeps the Dashboard's window
  const key = app ?? "/";
  const saved = geoms[key];
  const max = !!saved?.max;

  // Another app in the window, or the window back from the dock: it opens like one.
  const [shown, setShown] = useState({ app, hidden });
  if (desktop && (shown.app !== app || shown.hidden !== hidden)) {
    setShown({ app, hidden });
    if (!hidden) setAnim("in");
  }

  // Restore what this browser remembers, once the desktop first shows.
  const hydrated = useRef(false);
  // the window minimized or closed on this very page before a reload: it stays so (once)
  const keptHidden = useRef<"min" | "closed" | null>(null);
  useEffect(() => {
    if (!desktop || hydrated.current) return;
    hydrated.current = true;
    keptHidden.current = hydrateDesk(NAV_HREFS);
  }, [desktop]);

  // The page you go to is the window in front (and its app open, at that path).
  useEffect(() => {
    if (!desktop) return;
    const kept = keptHidden.current;
    keptHidden.current = null;
    if (kept === "closed") return;
    if (app) noteApp(app, pathname + window.location.search);
    if (kept !== "min") showWindow();
  }, [desktop, app, pathname]);

  useEffect(() => {
    const el = areaRef.current;
    if (!desktop || !el) return;
    const ro = new ResizeObserver(() => setWs({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [desktop]);

  const rectNow = (): Rect | null => {
    const el = winRef.current;
    return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
  };

  function minimize() {
    setAnim("out");
    window.setTimeout(() => {
      minimizeWindow();
      setAnim(null);
    }, 170);
  }

  function close() {
    const next = closeApp(app);
    if (next) router.push(next);
  }

  function toggleMax() {
    if (mobile) return;
    const cur = saved ?? rectNow();
    if (!cur) return;
    setGlide(true);
    window.setTimeout(() => setGlide(false), 260);
    setGeom(key, { x: cur.x, y: cur.y, w: cur.w, h: cur.h, ...(max ? {} : { max: true }) });
  }

  // Drag by the title bar; a maximized window comes back to its size under the pointer.
  function onBarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || mobile || (e.target as HTMLElement).closest("button, a, input")) return;
    const area = areaRef.current;
    const r0 = rectNow();
    if (!area || !r0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const W = area.clientWidth;
    const H = area.clientHeight;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let start = r0;
    let last: Rect | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!last) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        setDragging(true);
        deskDrag.next(true);
        if (max) start = unmaximizeUnder(saved ? clampRect(saved, W, H) : defaultGeom(W, H, dock), r0, x0 - area.getBoundingClientRect().left);
      }
      last = { ...start, x: start.x + dx, y: Math.max(0, start.y + dy) };
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!last) return;
      setGeom(key, clampRect(last, W, H));
      setLive(null);
      setDragging(false);
      deskDrag.next(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onResizePointerDown(edges: Edges, e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    const area = areaRef.current;
    const start = rectNow();
    if (!area || !start) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const W = area.clientWidth;
    const H = area.clientHeight;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = start;
    setDragging(true);
    deskDrag.next(true);
    const move = (ev: PointerEvent) => {
      last = resizeRect(start, edges, ev.clientX - x0, ev.clientY - y0, W, H);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setGeom(key, clampRect(last, W, H));
      setLive(null);
      setDragging(false);
      deskDrag.next(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // Before the workspace is measured (the server's paint, the first frame) the
  // window is placed by CSS, as defaultGeom / maxRect would place it.
  const rect = mobile
    ? null
    : (live ??
      (ws
        ? max
          ? maxRect(ws.w, ws.h, dock)
          : clampRect(saved ?? defaultGeom(ws.w, ws.h, dock), ws.w, ws.h)
        : saved && !max
          ? saved
          : null));
  // Alone, the window has no z-index (see above). With other windows, each one is a layer at its place in the stack,
  // this one too: else what it holds with a z-index of its own (its title bar's buttons, a page's sticky parts) would
  // show through the windows in front of it.
  const z = desktop && others.length ? winZ(order, MAIN_WIN) : undefined;
  const place: React.CSSProperties | undefined = !desktop
    ? undefined
    : mobile
      ? { inset: 0 }
      : rect
        ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
        : max
          ? { left: 8, top: 8, right: 8, bottom: dock }
          : { top: 12, right: 16, bottom: dock };
  const winStyle = place && z !== undefined ? { ...place, zIndex: z } : place;

  return (
    <div
      ref={areaRef}
      className={desktop ? "relative min-h-0 flex-1 overflow-hidden" : "scrollbar-clear flex-1 overflow-y-auto"}
    >
      {desktop && <DesktopBackground mobile={mobile} badgeOf={badgeOf} />}
      {desktop && <FrameWindows area={ws} mobile={mobile} dock={dock} />}
      <div
        ref={winRef}
        onPointerDownCapture={desktop ? () => focusWin(MAIN_WIN) : undefined}
        role={desktop ? "region" : undefined}
        aria-label={desktop ? `${item?.label ?? "Page"} window` : undefined}
        aria-hidden={desktop && hidden ? true : undefined}
        onAnimationEnd={(e) => e.target === e.currentTarget && anim === "in" && setAnim(null)}
        style={winStyle}
        className={
          desktop
            ? `absolute flex origin-bottom flex-col bg-background ${
                mobile
                  ? ""
                  : `rounded-xl border shadow-[0_28px_70px_-18px_rgb(0_0_0/0.5)] ring-1 ring-black/5 dark:ring-white/10 ${
                      rect ? "" : "left-[min(24px,3vw)] xl:left-[204px]"
                    }`
              } ${glide && !dragging ? "transition-[left,top,width,height] duration-200 ease-out" : ""} ${
                anim === "in" ? "motion-safe:animate-desk-in" : anim === "out" ? "motion-safe:animate-desk-out" : ""
              } ${hidden === "closed" ? "hidden" : hidden === "min" ? "invisible" : ""}`
            : "contents"
        }
      >
        {desktop && (
          <TitleBar
            item={item}
            pathname={pathname}
            mobile={mobile}
            max={max}
            onPointerDown={onBarPointerDown}
            onClose={close}
            onMinimize={minimize}
            onToggleMax={toggleMax}
          />
        )}
        <div
          className={
            desktop
              ? `scrollbar-clear min-h-0 flex-1 overflow-y-auto ${mobile ? "" : "rounded-b-[calc(var(--radius)*1.4-1px)]"} ${dragging ? "pointer-events-none select-none" : ""}`
              : "contents"
          }
        >
          {desktop && hidden === "closed" ? null : children}
        </div>
        {desktop && !mobile && !max && <ResizeHandles onPointerDown={onResizePointerDown} />}
      </div>
      {desktop && <Dock app={app} mobile={mobile} windowShown={!hidden} badgeOf={badgeOf} onMinimize={minimize} />}
      {desktop && <Launchpad badgeOf={badgeOf} />}
    </div>
  );
}

/* ------------------------------- the window ------------------------------- */

function TitleBar({
  item,
  pathname,
  mobile,
  max,
  onPointerDown,
  onClose,
  onMinimize,
  onToggleMax,
  nav,
}: {
  item: NavItem | null;
  pathname: string;
  mobile: boolean;
  max: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  /** a frame's own reload and address (the page's own window uses the router) */
  nav?: { reload: () => void; href: string };
}) {
  const router = useRouter();
  const reload = nav?.reload ?? (() => router.refresh());
  const crumbs = subPath(pathname, item?.href ?? null);
  const btn =
    "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => !(e.target as HTMLElement).closest("button, a") && onToggleMax()}
      className={`relative flex h-9 shrink-0 items-center gap-1 border-b bg-gradient-to-b from-muted/40 to-muted/90 px-3 select-none ${
        mobile ? "" : "rounded-t-[calc(var(--radius)*1.4-1px)]"
      }`}
    >
      {/* the traffic lights: their glyphs show while the pointer is over them */}
      <div className="group/lights z-10 mr-2 flex items-center gap-2">
        <Light color="bg-[#ff5f57]" label="Close window" onClick={onClose} glyph={X} mobile={mobile} />
        <Light color="bg-[#febc2e]" label="Minimize to the dock" onClick={onMinimize} glyph={Minus} mobile={mobile} />
        {!mobile && (
          <Light
            color="bg-[#28c840]"
            label={max ? "Restore size" : "Maximize"}
            onClick={onToggleMax}
            glyph={max ? Minimize2 : Maximize2}
            mobile={mobile}
          />
        )}
      </div>

      {/* the title, centred on the bar whatever sits either side */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center px-40 max-sm:justify-start max-sm:pr-16 max-sm:pl-36">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {item ? (
            <AppIcon item={item} size={16} />
          ) : (
            <AppWindow className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 font-medium">{item?.label ?? "Page"}</span>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <ChevronRight className="size-3 shrink-0 opacity-60" />
              <span className="truncate">{c}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="z-10 ml-auto flex items-center">
        <button type="button" aria-label="Reload" title="Reload" onClick={reload} className={btn}>
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Open in a new browser tab"
          title="Open in a new browser tab"
          onClick={() => window.open(nav ? nav.href : `${BASE_PATH}${pathname}${window.location.search}`, "_blank", "noopener")}
          className={btn}
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function Light({
  color,
  label,
  onClick,
  glyph: Glyph,
  mobile,
}: {
  color: string;
  label: string;
  onClick: () => void;
  glyph: typeof X;
  mobile: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex items-center justify-center rounded-full ${color} ring-1 ring-black/15 ring-inset ${
        mobile ? "size-4" : "size-3"
      }`}
    >
      <Glyph
        strokeWidth={3}
        className={`text-black/55 ${mobile ? "size-2.5" : "size-2 opacity-0 group-hover/lights:opacity-100"}`}
      />
    </button>
  );
}

/** The edges and corners a window resizes from, just outside its border. */
const HANDLES: { edges: Edges; className: string }[] = [
  { edges: { t: true }, className: "-top-1 inset-x-3 h-2 cursor-ns-resize" },
  { edges: { b: true }, className: "-bottom-1 inset-x-3 h-2 cursor-ns-resize" },
  { edges: { l: true }, className: "-left-1 inset-y-3 w-2 cursor-ew-resize" },
  { edges: { r: true }, className: "-right-1 inset-y-3 w-2 cursor-ew-resize" },
  { edges: { t: true, l: true }, className: "-top-1 -left-1 size-4 cursor-nwse-resize" },
  { edges: { t: true, r: true }, className: "-top-1 -right-1 size-4 cursor-nesw-resize" },
  { edges: { b: true, l: true }, className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
  { edges: { b: true, r: true }, className: "-right-1 -bottom-1 size-4 cursor-nwse-resize" },
];

function ResizeHandles({ onPointerDown }: { onPointerDown: (edges: Edges, e: React.PointerEvent<HTMLElement>) => void }) {
  return (
    <>
      {HANDLES.map((h, i) => (
        <span
          key={i}
          aria-hidden
          onPointerDown={(e) => onPointerDown(h.edges, e)}
          className={`absolute z-20 touch-none ${h.className}`}
        />
      ))}
    </>
  );
}

/* ------------------------------ more windows ------------------------------ */

/** A window's layer: its place in the stack, back to front, from 1 (all under the dock's 40). */
function winZ(order: string[], id: string): number {
  return Math.min(order.indexOf(id) + 1, 39);
}

/**
 * The desktop's other windows: each another page of the app in a frame (the page there renders alone, as
 * app-shell's FramedPage), back to front as `stack` says, each a layer at its place in it (winZ), as the page's own
 * window is while they're open.
 */
function FrameWindows({ area, mobile, dock }: { area: { w: number; h: number } | null; mobile: boolean; dock: number }) {
  const [list] = useSubject(frames);
  const [order] = useSubject(stack);

  // What the frames say: where they've gone, a click in one (to the front), ⌘K, a terminal to open.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || typeof e.data?.type !== "string") return;
      const el = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-desk-frame]")].find((f) => f.contentWindow === e.source);
      if (!el?.dataset.deskFrame) return;
      const id = el.dataset.deskFrame;
      if (e.data.type === "spiridus:path" && typeof e.data.path === "string" && e.data.path.startsWith("/"))
        updateFrame(id, { path: e.data.path, app: appOf(e.data.path.split("?")[0], NAV_HREFS) });
      else if (e.data.type === "spiridus:focus") focusWin(id);
      else if (e.data.type === "spiridus:palette") commandPalette.next(!commandPalette.getValue());
      else if (e.data.type === "spiridus:terminal" && typeof e.data.name === "string") openTerminal(e.data.name);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (!area) return null;
  return (
    <>
      {list.map((f, i) => (
        <FrameWindow key={f.id} win={f} z={winZ(order, f.id)} cascade={i} area={area} mobile={mobile} dock={dock} />
      ))}
    </>
  );
}

function FrameWindow({
  win,
  z,
  cascade,
  area,
  mobile,
  dock,
}: {
  win: FrameWin;
  z: number;
  cascade: number;
  area: { w: number; h: number };
  mobile: boolean;
  /** the room kept for the dock, at its size */
  dock: number;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  // (the frame's first page: later ones it goes to itself, and its src mustn't follow, or it would reload)
  const [src] = useState(() => `${BASE_PATH}${win.path}`);
  const [dragAny] = useSubject(deskDrag);
  const [live, setLive] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [glide, setGlide] = useState(false);
  const item = win.app ? (BY_HREF.get(win.app) ?? null) : null;
  const { w: W, h: H } = area;
  const max = !!win.geom?.max;
  // a new window: the default place, each one a step down and right from the one before
  const start = (): Rect => {
    const d = defaultGeom(W, H, dock);
    const step = 28 * ((cascade % 6) + 1);
    return clampRect({ ...d, x: d.x + step, y: d.y + step }, W, H);
  };
  const placed = win.geom ? clampRect(win.geom, W, H) : start();
  const rect = live ?? (max ? maxRect(W, H, dock) : placed);

  const saveGeom = (r: Rect, isMax = max) => updateFrame(win.id, { geom: { ...clampRect(r, W, H), ...(isMax ? { max: true } : {}) } });

  function toggleMax() {
    if (mobile) return;
    setGlide(true);
    window.setTimeout(() => setGlide(false), 260);
    saveGeom(placed, !max);
  }

  function onBarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || mobile || (e.target as HTMLElement).closest("button, a, input")) return;
    focusWin(win.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let from = rect;
    let last: Rect | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!last) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        setDragging(true);
        deskDrag.next(true);
        if (max) {
          const left = winRef.current?.parentElement?.getBoundingClientRect().left ?? 0;
          from = unmaximizeUnder(placed, rect, x0 - left);
        }
      }
      last = { ...from, x: from.x + dx, y: Math.max(0, from.y + dy) };
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!last) return;
      saveGeom(last, false);
      setLive(null);
      setDragging(false);
      deskDrag.next(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onResizePointerDown(edges: Edges, e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    focusWin(win.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = rect;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = from;
    setDragging(true);
    deskDrag.next(true);
    const move = (ev: PointerEvent) => {
      last = resizeRect(from, edges, ev.clientX - x0, ev.clientY - y0, W, H);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      saveGeom(last);
      setLive(null);
      setDragging(false);
      deskDrag.next(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const cw = () => frameRef.current?.contentWindow ?? null;
  return (
    <div
      ref={winRef}
      role="region"
      aria-label={`${item?.label ?? "Page"} window`}
      aria-hidden={win.hidden ? true : undefined}
      onPointerDownCapture={() => focusWin(win.id)}
      style={mobile ? { inset: 0, zIndex: z } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
      className={`absolute flex origin-bottom flex-col bg-background motion-safe:animate-desk-in ${
        mobile ? "" : "rounded-xl border shadow-[0_28px_70px_-18px_rgb(0_0_0/0.5)] ring-1 ring-black/5 dark:ring-white/10"
      } ${glide && !dragging ? "transition-[left,top,width,height] duration-200 ease-out" : ""} ${win.hidden ? "invisible" : ""}`}
    >
      <TitleBar
        item={item}
        pathname={win.path.split("?")[0]}
        mobile={mobile}
        max={max}
        onPointerDown={onBarPointerDown}
        onClose={() => closeFrame(win.id)}
        onMinimize={() => updateFrame(win.id, { hidden: true })}
        onToggleMax={toggleMax}
        nav={{
          reload: () => cw()?.location.reload(),
          href: `${BASE_PATH}${win.path}`,
        }}
      />
      <iframe
        ref={frameRef}
        data-desk-frame={win.id}
        src={src}
        title={`${item?.label ?? "Page"}: ${win.path}`}
        className={`min-h-0 w-full flex-1 bg-background ${mobile ? "" : "rounded-b-[calc(var(--radius)*1.4-1px)]"} ${
          dragAny ? "pointer-events-none select-none" : ""
        }`}
      />
      {!mobile && !max && <ResizeHandles onPointerDown={onResizePointerDown} />}
    </div>
  );
}

/* ------------------------------ the desktop ------------------------------- */

/** The wallpaper (globals.css .desk-wallpaper) with the wisp, faint, in the middle. */
function Wallpaper() {
  return (
    <div aria-hidden className="desk-wallpaper pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        viewBox="0 0 32 32"
        className="absolute top-[44%] left-1/2 size-[44vmin] -translate-x-1/2 -translate-y-1/2 text-foreground opacity-[0.06]"
      >
        <defs>
          <mask id="desk-wisp-eyes">
            <rect width="32" height="32" fill="white" />
            {WISP_EYES.map((e, i) => (
              <ellipse key={i} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill="black" />
            ))}
          </mask>
        </defs>
        <path d={WISP_BODY} fill="currentColor" mask="url(#desk-wisp-eyes)" />
      </svg>
    </div>
  );
}

/**
 * Every app as an icon on the wallpaper: on a computer, each where it was dragged to, the widgets among them
 * (IconGrid); on a phone, a home screen grid in the default order.
 */
function DesktopBackground({ mobile, badgeOf }: { mobile: boolean; badgeOf: BadgeOf }) {
  const [{ pinned, icons, widgets, removedIcons, dockSize, align }] = useSubject(desk);
  const [open] = useSubject(openApps);
  const all = [
    ...NAV_FLAT.map((it) => ({
      id: it.href,
      label: it.label,
      node: (
        <DeskIcon
          item={it}
          badge={badgeOf(it.href)}
          pinned={pinned.includes(it.href)}
          path={open.find((o) => o.app === it.href)?.path ?? it.href}
        />
      ),
    })),
    // VS Code (code-server) lives outside the basePath: a raw <a>, gated by nginx.
    {
      id: VSCODE_ICON,
      label: "VS Code",
      node: (
        <ContextMenu>
          <ContextMenuTrigger>
            <a
              href="/vscode/"
              target="_blank"
              rel="noreferrer"
              draggable={false}
              className="group flex w-[84px] flex-col items-center gap-1 rounded-lg p-1.5 outline-none focus-visible:bg-white/25 dark:focus-visible:bg-white/10"
            >
              <span className="transition-transform duration-150 group-hover:-translate-y-0.5 group-active:scale-95">
                <VsCodeIcon size={52} />
              </span>
              <IconLabel>VS Code</IconLabel>
            </a>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onClick={() => window.open("/vscode/", "_blank", "noreferrer")}>Open VS Code</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setPinned(VSCODE_ICON, !pinned.includes(VSCODE_ICON))}>
              {pinned.includes(VSCODE_ICON) ? "Remove from Dock" : "Keep in Dock"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setOnDesktop(VSCODE_ICON, false)}>Remove from Desktop</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ),
    },
  ];
  // (an icon taken off the desktop: the dock's, the Launchpad's and Settings' menus put it back)
  const items = removedIcons ? all.filter((i) => !removedIcons.includes(i.id)) : all;
  return (
    <>
      <Wallpaper />
      {mobile ? (
        <nav
          aria-label="Apps"
          className="scrollbar-hover absolute inset-0 grid auto-rows-[96px] grid-cols-4 content-start justify-items-center overflow-y-auto p-3 pb-28"
        >
          {items.map((i) => (
            <div key={i.id}>{i.node}</div>
          ))}
        </nav>
      ) : (
        <IconGrid items={items} saved={icons} widgets={widgets} dock={dockSpace(dockSize)} align={align ?? "left"} />
      )}
    </>
  );
}

type DeskItem = { id: string; label: string; node: React.ReactNode };

/**
 * The desktop's icons and widgets on one grid (lib/desktop.ts). Drag an icon anywhere and it snaps to the nearest
 * spot, swapping with an icon already there (layoutIcons, moveIcon; desk.icons); a press that doesn't move is a click,
 * as before. A widget takes a span of spots (WidgetFrame; deskWidgets, desk.widgets), and the icons keep off it. The
 * whole arrangement is drawn against the left, centred or against the right (alignShift; desk.align), as it is. A
 * right-click on the wallpaper (not on an icon or a widget) opens the desktop's menu (DeskMenu).
 */
function IconGrid({
  items,
  saved,
  widgets,
  dock,
  align,
}: {
  items: DeskItem[];
  saved?: Record<string, Cell>;
  widgets: DeskSaved["widgets"];
  /** the room kept for the dock, at its size */
  dock: number;
  align: DeskAlign;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragging = drag !== null;
  // (the window losing the focus mid-drag, to another window or tab, may never hand the pointer back: the drag ends)
  useEffect(() => {
    if (!dragging) return;
    const end = () => {
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("blur", end);
    return () => window.removeEventListener("blur", end);
  }, [dragging]);
  const press = useRef<{ id: string; px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  // the desktop's menu: where it was opened, and the spot under it (a widget added from it goes there)
  const [menu, setMenu] = useState<{ x: number; y: number; cell: Cell } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Icons glide only to settle a drop (the one swapped with sliding over, or those a widget dropped on makes move);
  // placed any other way (the first measure, the saved arrangement restored, a resize) they're simply there.
  const [glide, setGlide] = useState(false);
  const glideTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(glideTimer.current), []);
  const settle = () => {
    setGlide(true);
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 260);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = size?.w ?? 0;
  const { cols, rows: fitRows } = size ? iconGridSize(size.w, size.h, dock) : { cols: 1, rows: 1 };
  const wants = useMemo(() => widgetWants(widgets, cols), [widgets, cols]);
  // A window shorter than the arrangement doesn't squeeze it (widgets pushed up onto each other): the grid has the
  // rows it needs, the desktop grows below the window, and scrolls. (Narrower, it stacks instead: below.)
  const rows = Math.max(fitRows, ...wants.map((w) => w.at.r + w.at.h), ...items.map((i) => (saved?.[i.id]?.r ?? -1) + 1));
  const placed = useMemo(() => placeWidgets(wants, cols, rows) as Partial<Record<WidgetId, CellRect>>, [wants, cols, rows]);
  const blocked = useMemo(() => Object.values(placed).filter((r): r is CellRect => !!r), [placed]);
  const idsKey = items.map((i) => i.id).join("\n");
  const layout = useMemo(() => layoutIcons(idsKey.split("\n"), saved, cols, rows, blocked, fitRows), [idsKey, saved, cols, rows, blocked, fitRows]);
  // (the rows it all takes: the desktop's height, to scroll)
  const usedRows = Math.max(rows, ...Object.values(layout).map((c) => c.r + 1));
  // A window too narrow for the arrangement (a widget pushed onto the grid or off another, an icon past the columns):
  // the desktop stacks, the widgets one a row the whole width, the icons under them, and it scrolls; nothing moves by
  // hand until there's room again, when the arrangement is back as it was.
  const stack = useMemo(
    () => (size && !arrangementFits(wants, placed, layout, cols) ? stackDesktop(wants, idsKey.split("\n"), W) : null),
    [size, wants, placed, layout, cols, idsKey, W],
  );
  /** the icons (a cell each) and the widgets, but `skip` (the one being moved) */
  const spansBut = (skip?: string) => [
    ...Object.entries(layout)
      .filter(([id]) => id !== skip)
      .map(([, c]) => ({ ...c, w: 1, h: 1 })),
    ...WIDGETS.flatMap((id) => (id !== skip && placed[id] ? [placed[id]] : [])),
  ];
  // (everything below is in the arrangement's own coordinates: the layer it's drawn in is `shift` px right)
  const shift = size && !stack ? alignShift(align, spansBut(), W) : 0;
  const spot = (c: Cell) => ({ left: ICON_GRID.pad + c.c * ICON_GRID.x, top: ICON_GRID.pad + c.r * ICON_GRID.y });
  const cellAt = (id: string, x: number, y: number): Cell => {
    const { lo, hi } = dropRange(spansBut(id), 1, cols, shift, W);
    return {
      c: Math.min(Math.max(Math.round((x - ICON_GRID.pad) / ICON_GRID.x), lo), Math.max(lo, hi)),
      r: Math.min(Math.max(Math.round((y - ICON_GRID.pad) / ICON_GRID.y), 0), rows - 1),
    };
  };
  /** not under a widget */
  const free = (c: Cell) => !blocked.some((b) => overlaps(b, { ...c, w: 1, h: 1 }));
  /** where the dragged icon's top-left is now */
  const dragPos = (e: React.PointerEvent, p: NonNullable<typeof press.current>) => {
    const b = box.current!.getBoundingClientRect();
    return { x: e.clientX - b.left - p.ox - shift, y: e.clientY - b.top - p.oy + box.current!.scrollTop };
  };
  const target = drag ? cellAt(drag.id, drag.x, drag.y) : null;

  /** a folded widget's span as saved: the height it unfolds to */
  const fullAt = (id: WidgetId, at: CellRect): CellRect =>
    widgetMode(widgets, id) === "collapsed" ? { ...at, h: (widgets?.[id]?.at ?? defaultWidgetAt(id, cols)).h } : at;
  // A drop keeps the arrangement on the grid: one left of its first column (or right of its last) moves the whole of
  // it over by as much, so nothing moves on screen but what was dropped.
  const commit = (icons: Record<string, Cell>, moved?: { id: WidgetId; at: CellRect }) => {
    const wids: Partial<Record<WidgetId, CellRect>> = { ...placed, ...(moved ? { [moved.id]: moved.at } : {}) };
    const dc = fitShift([...Object.values(icons).map((c) => ({ ...c, w: 1, h: 1 })), ...Object.values(wids).filter((r): r is CellRect => !!r)], cols);
    settle();
    if (!dc) {
      if (moved) setWidgetAt(moved.id, fullAt(moved.id, moved.at));
      // (an icon off the desktop keeps its spot, for when it's back)
      else setIcons({ ...saved, ...icons });
      return;
    }
    const over = <T extends Cell>(c: T): T => ({ ...c, c: c.c + dc });
    setArrangement(
      Object.fromEntries(Object.entries({ ...saved, ...icons }).map(([id, c]) => [id, over(c)])),
      Object.fromEntries(WIDGETS.flatMap((id) => (wids[id] ? [[id, over(fullAt(id, wids[id]))]] : []))),
    );
  };
  // A widget put on the desktop from its menu: at the spot it was opened on, at the size it had (or its default),
  // the nearest free spot when another widget is there.
  const addWidget = (id: WidgetId, cell: Cell) => {
    const size = widgets?.[id]?.at ?? defaultWidgetAt(id, cols);
    const others = WIDGETS.flatMap((o) => (o !== id && placed[o] ? [{ id: o, at: placed[o] }] : []));
    const at = placeWidgets([...others, { id, at: { ...cell, w: size.w, h: size.h } }], cols, rows)[id];
    settle();
    setWidgetAt(id, at, true);
  };

  return (
    <div
      ref={box}
      // (it scrolls when the arrangement is taller than the window; the gutter's kept, so a scrollbar showing up doesn't
      // narrow the desktop by a column)
      className="scrollbar-hover absolute inset-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      // (measured first: until then nothing is placed, so nothing jumps)
      style={{ visibility: size ? "visible" : "hidden" }}
      onContextMenu={(e) => {
        // (an icon's or a widget's own menu is theirs)
        if ((e.target as HTMLElement).closest("[data-desk-item], aside")) return;
        e.preventDefault();
        const b = box.current!.getBoundingClientRect();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          cell: {
            c: Math.min(Math.max(Math.floor((e.clientX - b.left - shift - ICON_GRID.pad) / ICON_GRID.x), 0), cols - 1),
            r: Math.min(Math.max(Math.floor((e.clientY - b.top + box.current!.scrollTop - ICON_GRID.pad) / ICON_GRID.y), 0), rows - 1),
          },
        });
      }}
    >
      <div
        className={`absolute top-0 ${glide ? "transition-[left] duration-200 ease-out" : ""}`}
        style={{ left: shift, width: W, height: Math.max(size?.h ?? 0, ICON_GRID.pad * 2 + (stack ? stack.rows : usedRows) * ICON_GRID.y + dock) }}
      >
        <nav aria-label="Apps" className="absolute inset-0">
          {target && free(target) && (
            <div aria-hidden className="pointer-events-none absolute h-[96px] w-[88px] rounded-xl border-2 border-dashed border-foreground/30 bg-foreground/5" style={spot(target)} />
          )}
          {items.map((i) => {
            const dragging = drag?.id === i.id;
            const at = dragging ? { left: drag.x, top: drag.y } : spot((stack ? stack.icons[i.id] : layout[i.id]) ?? { c: 0, r: 0 });
            return (
              <div
                key={i.id}
                data-desk-item
                style={at}
                className={
                  dragging
                    ? "absolute z-10 scale-105 cursor-grabbing opacity-90 drop-shadow-xl"
                    : glide
                      ? "absolute transition-[left,top] duration-200 ease-out"
                      : "absolute"
                }
                onPointerDown={(e) => {
                  if (e.button !== 0 || stack) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  press.current = { id: i.id, px: e.clientX, py: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
                }}
                onPointerMove={(e) => {
                  const p = press.current;
                  if (!p || p.id !== i.id) return;
                  if (!p.moved) {
                    if (Math.hypot(e.clientX - p.px, e.clientY - p.py) < 5) return;
                    p.moved = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  setDrag({ id: i.id, ...dragPos(e, p) });
                }}
                onPointerUp={(e) => {
                  const p = press.current;
                  press.current = null;
                  if (!p?.moved || p.id !== i.id) return;
                  // (the click that ends a drag doesn't open the app)
                  swallowClick.current = true;
                  setTimeout(() => (swallowClick.current = false), 0);
                  const { x, y } = dragPos(e, p);
                  setDrag(null);
                  // (dropped on a widget, it goes back)
                  const to = cellAt(i.id, x, y);
                  const next = free(to) ? moveIcon(layout, i.id, to) : layout;
                  if (next !== layout) commit(next);
                }}
                onPointerCancel={() => {
                  press.current = null;
                  setDrag(null);
                }}
                // (the pointer let go without a pointerup reaching here: the window lost it mid-drag. The drag ends
                // where it began, or it would stay drawn mid-air with its drop target, for good)
                onLostPointerCapture={() => {
                  press.current = null;
                  setDrag(null);
                }}
                onClickCapture={(e) => {
                  if (!swallowClick.current) return;
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDragStart={(e) => e.preventDefault()}
              >
                {i.node}
              </div>
            );
          })}
        </nav>
        {WIDGETS.map((id) => {
          const at = placed[id];
          if (!at) return null;
          const folded = widgetMode(widgets, id) === "collapsed";
          const others = spansBut(id);
          const cell = dropRange(others, 1, cols, shift, W);
          return (
            <WidgetFrame
              key={id}
              label={WIDGET_LABEL[id]}
              at={at}
              locked={stack?.widgets[id]}
              folded={folded}
              rows={rows}
              moveCols={dropRange(others, at.w, cols, shift, W)}
              sizeCols={{ lo: cell.lo, hi: cell.hi + 1 }}
              others={blocked.filter((b) => b !== at)}
              onPlace={(to) => commit(layout, { id, at: to })}
            >
              {(() => {
                const Body = WIDGET_BODY[id];
                return <Body folded={folded} />;
              })()}
            </WidgetFrame>
          );
        })}
      </div>
      {menu && (
        <DeskMenu
          x={menu.x}
          y={menu.y}
          shown={(id) => !!placed[id]}
          onWidget={(id) => (placed[id] ? setWidgetMode(id, "hidden") : addWidget(id, menu.cell))}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/**
 * The desktop's own right-click menu (on the wallpaper, not on an icon or a widget), as macOS's: each widget, ticked
 * when it's on the desktop (a click puts it where the menu was opened, or takes it off), then the icons' order and
 * Settings. Closes on a click elsewhere, Escape, or the window losing focus.
 */
function DeskMenu({
  x,
  y,
  shown,
  onWidget,
  onClose,
}: {
  x: number;
  y: number;
  shown: (id: WidgetId) => boolean;
  onWidget: (id: WidgetId) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };
  // (down and right of the pointer, or up / left of it where the screen ends)
  const place: React.CSSProperties = {
    ...(x > window.innerWidth - 240 ? { right: window.innerWidth - x } : { left: x }),
    ...(y > window.innerHeight - 280 ? { bottom: window.innerHeight - y } : { top: y }),
  };
  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0";
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Desktop"
      style={place}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
    >
      <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Widgets</p>
      {WIDGETS.map((id) => {
        const Icon = WIDGET_ICON[id];
        const on = shown(id);
        return (
          <button key={id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={pick(() => onWidget(id))} className={row}>
            <Icon className="text-muted-foreground" />
            {WIDGET_LABEL[id]}
            {on && <Check className="ml-auto" />}
          </button>
        );
      })}
      <div className="-mx-1 my-1 h-px bg-border" />
      <button type="button" role="menuitem" onClick={pick(sortIconsByName)} className={row}>
        Sort icons by name
      </button>
      <button type="button" role="menuitem" onClick={pick(() => openSettings(pathname, (href) => router.push(href)))} className={row}>
        Settings…
      </button>
    </div>,
    document.body,
  );
}

/**
 * A widget on the desktop's grid (IconGrid): dragged anywhere by its header ([data-widget-grip]), resized from any
 * edge or corner down to WIDGET_MIN (three icons by three). Either way it follows the pointer with the span it will
 * take outlined (red where it would cover the other widget: let go there, it goes back), and settles on that span when
 * let go. Folded, it's one row of icons tall (its header as a glance), and only moves.
 */
function WidgetFrame({
  label,
  at,
  locked,
  folded,
  rows,
  moveCols,
  sizeCols,
  others,
  onPlace,
  children,
}: {
  label: string;
  /** its span, as placed (folded: its header's row) */
  at: CellRect;
  /** where the stacked desktop puts it: there, and not moved or resized by hand */
  locked?: Rect;
  folded: boolean;
  rows: number;
  /** the columns it can start at, moved (dropRange) */
  moveCols: { lo: number; hi: number };
  /** where its left and right edges can go, resized */
  sizeCols: { lo: number; hi: number };
  /** the other widgets' spans, which it can't cover */
  others: CellRect[];
  onPlace: (to: CellRect) => void;
  children: React.ReactNode;
}) {
  const [live, setLive] = useState<{ rect: Rect; to: CellRect } | null>(null);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const px = locked ?? cellsRect(at);
  const fits = (to: CellRect) => !others.some((o) => overlaps(o, to));

  // Follows the pointer from a press on the grip or an edge (short of a few pixels, it's a click).
  function track(e: React.PointerEvent<HTMLElement>, step: (dx: number, dy: number) => { rect: Rect; to: CellRect }) {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: { rect: Rect; to: CellRect } | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!last) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        deskDrag.next(true);
      }
      last = step(dx, dy);
      setLive(last);
    };
    // (ends on the pointer's release; also when the window loses the pointer, or itself the focus, mid-drag, which
    // sends no pointerup: then it goes back, rather than stay half-way for good)
    const up = (ev: Event) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      el.removeEventListener("lostpointercapture", up);
      if (!last) return;
      setLive(null);
      deskDrag.next(false);
      setSettling(true);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setSettling(false), 260);
      if (ev.type === "pointerup" && fits(last.to)) onPlace(last.to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    el.addEventListener("lostpointercapture", up);
  }

  function onGripDown(e: React.PointerEvent<HTMLElement>) {
    const el = e.target as HTMLElement;
    if (locked || e.button !== 0 || !el.closest("[data-widget-grip]") || el.closest("button, a, input")) return;
    track(e, (dx, dy) => ({
      rect: { ...px, x: px.x + dx, y: px.y + dy },
      to: moveCells(at, dx / ICON_GRID.x, dy / ICON_GRID.y, moveCols, rows),
    }));
  }

  function onResizeDown(edges: Edges, e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // (the live rect stays within the room it can take, measured from that room's corner)
    const room = cellsRect({ c: sizeCols.lo, r: 0, w: sizeCols.hi - sizeCols.lo, h: rows });
    const min = cellsRect({ c: 0, r: 0, ...WIDGET_MIN });
    track(e, (dx, dy) => {
      const r = resizeRect({ ...px, x: px.x - room.x, y: px.y - room.y }, edges, dx, dy, room.w, room.h, min);
      return {
        rect: { ...r, x: r.x + room.x, y: r.y + room.y },
        to: resizeCells(at, edges, dx / ICON_GRID.x, dy / ICON_GRID.y, sizeCols, rows),
      };
    });
  }

  const rect = live?.rect ?? px;
  const outline = live ? { ...cellsRect(live.to), ok: fits(live.to) } : null;
  return (
    <>
      {outline && (
        <div
          aria-hidden
          // (above the other widget, which it would cover: the dragged one, later, is above it)
          className={`pointer-events-none absolute z-10 rounded-2xl border-2 border-dashed ${
            outline.ok ? "border-foreground/30 bg-foreground/5" : "border-destructive/60 bg-destructive/10"
          }`}
          style={{ left: outline.x, top: outline.y, width: outline.w, height: outline.h }}
        />
      )}
      <aside
        aria-label={label}
        onPointerDown={onGripDown}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        className={`group/widget absolute flex flex-col rounded-2xl border border-white/40 bg-white/55 text-foreground shadow-[0_18px_40px_-16px_rgb(0_0_0/0.35)] ring-1 ring-black/5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/55 dark:ring-white/5 ${
          live ? `z-10 ${outline?.ok ? "" : "ring-2 ring-destructive/60"}` : settling ? "transition-[left,top,width,height] duration-200 ease-out" : ""
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{children}</div>
        {!folded && !locked && <ResizeHandles onPointerDown={onResizeDown} />}
      </aside>
    </>
  );
}

function IconLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="line-clamp-2 rounded px-1 text-center text-[11.5px] leading-tight font-medium text-foreground [text-shadow:0_1px_2px_color-mix(in_oklab,var(--background)_85%,transparent)] group-focus-visible:bg-primary group-focus-visible:text-primary-foreground group-focus-visible:[text-shadow:none]">
      {children}
    </span>
  );
}

function DeskIcon({
  item,
  badge,
  pinned,
  path,
}: {
  item: NavItem;
  badge: number | null;
  pinned: boolean;
  /** where it opens: the path it was left on, if it's open */
  path: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mainApp = appOf(pathname, NAV_HREFS);
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Link
          href={path}
          draggable={false}
          onClick={(e) => {
            // its window to the front, or a new one (the page's own window when that's closed)
            if (openAppWindow(item.href, path, mainApp)) e.preventDefault();
            else showWindow();
          }}
          aria-label={badge ? `${item.label} (${badge})` : item.label}
          title={badge ? `${item.label} (${badge})` : item.label}
          className="group flex w-[84px] flex-col items-center gap-1 rounded-lg p-1.5 outline-none focus-visible:bg-white/25 dark:focus-visible:bg-white/10"
        >
          <span className="transition-transform duration-150 group-hover:-translate-y-0.5 group-active:scale-95">
            <AppIcon item={item} size={52} badge={badge} />
          </span>
          <IconLabel>{item.label}</IconLabel>
        </Link>
      </ContextMenuTrigger>
      <AppMenu
        href={item.href}
        label={item.label}
        pinned={pinned}
        onOpen={() => {
          if (openAppWindow(item.href, path, mainApp)) return;
          showWindow();
          router.push(path);
        }}
        onNewWindow={() => openFrame(path, item.href)}
        onNewTab={() => window.open(`${BASE_PATH}${path}`, "_blank", "noopener")}
        onPin={() => setPinned(item.href, !pinned)}
      />
    </ContextMenu>
  );
}

/** An app's right-click menu, on the desktop and in the dock. */
function AppMenu({
  href,
  label,
  pinned,
  onOpen,
  onNewWindow,
  onNewTab,
  onPin,
  onClose,
}: {
  href: string;
  label: string;
  pinned: boolean;
  onOpen: () => void;
  onNewWindow: () => void;
  onNewTab: () => void;
  onPin: () => void;
  onClose?: () => void;
}) {
  const [{ removedIcons }] = useSubject(desk);
  const onDesktop = !removedIcons?.includes(href);
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onClick={onOpen}>Open {label}</ContextMenuItem>
      <ContextMenuItem onClick={onNewWindow}>Open in a new window</ContextMenuItem>
      <ContextMenuItem onClick={onNewTab}>Open in a new browser tab</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onPin}>{pinned ? "Remove from Dock" : "Keep in Dock"}</ContextMenuItem>
      <ContextMenuItem onClick={() => setOnDesktop(href, !onDesktop)}>{onDesktop ? "Remove from Desktop" : "Add to Desktop"}</ContextMenuItem>
      {onClose && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onClose}>Close window</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

/* -------------------------------- the dock -------------------------------- */

const DOCK_ICON_MOBILE = 44;
/** How much the icon under the pointer grows, and how far the swell reaches (px). */
const MAGNIFY = 0.55;
const MAGNIFY_RANGE = 130;

/**
 * Launchpad, the pinned apps, then the apps open in this tab that aren't
 * pinned. Each grows as the pointer passes (a `--s` scale per item, set straight
 * on the DOM in a frame callback, so a pointer move re-renders nothing).
 */
function Dock({
  app,
  mobile,
  windowShown,
  badgeOf,
  onMinimize,
}: {
  app: string | null;
  mobile: boolean;
  windowShown: boolean;
  badgeOf: BadgeOf;
  onMinimize: () => void;
}) {
  const router = useRouter();
  const [{ pinned, dockSize }] = useSubject(desk);
  const [open] = useSubject(openApps);
  const [pad] = useSubject(launchpad);
  const [wins] = useSubject(frames);
  useSubject(stack); // (which window is in front decides what a click does)
  const dockRef = useRef<HTMLDivElement>(null);
  const centers = useRef<{ el: HTMLElement; c: number }[]>([]);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const frameApps = wins.map((f) => f.app).filter((a): a is string => !!a);
  const extra = [...new Set([...open.map((o) => o.app), ...frameApps])].filter((a) => !pinned.includes(a));
  const size = mobile ? DOCK_ICON_MOBILE : (dockSize ?? DOCK_ICON.default);
  // (resizing from a divider: no swell meanwhile, and the icons' places measured afresh after)
  const resizing = useRef(false);

  // On a phone the open window has the whole screen; the dock is for the home screen.
  if (mobile && windowShown) return null;

  const measure = () => {
    centers.current = [...(dockRef.current?.querySelectorAll<HTMLElement>("[data-dock-item]") ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, c: r.left + r.width / 2 };
    });
  };
  const onMove = (e: React.PointerEvent) => {
    if (mobile || e.pointerType === "touch" || resizing.current) return;
    if (!centers.current.length) measure();
    const x = e.clientX;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      for (const { el, c } of centers.current) {
        const t = Math.max(0, 1 - Math.abs(x - c) / MAGNIFY_RANGE);
        el.style.setProperty("--s", (1 + MAGNIFY * t * t * (3 - 2 * t)).toFixed(3));
      }
    });
  };
  const onLeave = () => {
    cancelAnimationFrame(frame.current);
    for (const { el } of centers.current) el.style.setProperty("--s", "1");
    centers.current = [];
  };
  const startResize = () => {
    resizing.current = true;
    onLeave();
  };
  const endResize = () => {
    resizing.current = false;
  };

  const appItem = (href: string) => {
    if (href === VSCODE_ICON) return <VsCodeDockItem key={href} size={size} />;
    const it = BY_HREF.get(href);
    if (!it) return null;
    const entry = open.find((o) => o.app === href);
    const appFrames = wins.filter((f) => f.app === href);
    const isPinned = pinned.includes(href);
    const path = entry?.path ?? appFrames[0]?.path ?? href;
    return (
      <ContextMenu key={href}>
        <ContextMenuTrigger>
          <DockSlot label={it.label} size={size} running={!!entry || appFrames.length > 0}>
            <Link
              href={path}
              aria-label={it.label}
              onClick={(e) => {
                // the app in front: its window goes down to the dock (as a taskbar does)
                const front = frontWin();
                if (href === app && windowShown && front === MAIN_WIN) {
                  e.preventDefault();
                  onMinimize();
                  return;
                }
                const inFront = appFrames.find((f) => f.id === front);
                if (inFront) {
                  e.preventDefault();
                  updateFrame(inFront.id, { hidden: true });
                  return;
                }
                if (openAppWindow(href, path, app)) e.preventDefault();
                else showWindow();
              }}
              className="block outline-none focus-visible:rounded-[24%] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AppIcon item={it} size={size} badge={badgeOf(href)} />
            </Link>
          </DockSlot>
        </ContextMenuTrigger>
        <AppMenu
          href={href}
          label={it.label}
          pinned={isPinned}
          onOpen={() => {
            if (openAppWindow(href, path, app)) return;
            showWindow();
            router.push(path);
          }}
          onNewWindow={() => openFrame(path, href)}
          onNewTab={() => window.open(`${BASE_PATH}${path}`, "_blank", "noopener")}
          onPin={() => setPinned(href, !isPinned)}
          onClose={
            entry || appFrames.length
              ? () => {
                  for (const f of appFrames) closeFrame(f.id);
                  if (!entry) return;
                  const next = closeApp(href);
                  // closing the one in front shows the next (or the bare desktop)
                  if (href === app && next) router.push(next);
                  else if (href !== app) showWindow();
                }
              : undefined
          }
        />
      </ContextMenu>
    );
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-40 flex justify-center px-2">
      <div
        ref={dockRef}
        onPointerEnter={measure}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className={`pointer-events-auto flex items-end gap-1.5 rounded-[22px] border border-white/40 bg-white/45 px-2 pt-2 pb-2.5 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.45)] ring-1 ring-black/5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/50 dark:ring-white/5 ${
          mobile ? "scrollbar-hover max-w-full overflow-x-auto" : ""
        }`}
      >
        <DockSlot label="Launchpad" size={size}>
          <button
            type="button"
            aria-label="Launchpad: every app and project"
            aria-pressed={pad}
            onClick={() => launchpad.next(!pad)}
            className="block rounded-[24%] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LaunchpadIcon size={size} />
          </button>
        </DockSlot>
        <DockDivider size={size} resizable={!mobile} onStart={startResize} onEnd={endResize} />
        {pinned.map(appItem)}
        {extra.length > 0 && (
          <DockDivider size={size} resizable={!mobile} onStart={startResize} onEnd={endResize} />
        )}
        {extra.map(appItem)}
      </div>
    </div>
  );
}

/**
 * The line between the dock's parts, which resizes it as macOS's does: drag it up for bigger icons, down for smaller
 * (DOCK_ICON's range, desk.dockSize), or use the arrow keys on it. The windows and the icon grid keep clear of the dock
 * at its size (dockSpace).
 */
function DockDivider({ size, resizable, onStart, onEnd }: { size: number; resizable: boolean; onStart: () => void; onEnd: () => void }) {
  const line = <span className="w-px bg-foreground/15 transition-colors group-hover/divider:bg-foreground/45" style={{ height: Math.round(size * 0.75) }} />;
  if (!resizable)
    return (
      <span aria-hidden className="mx-0.5 flex self-center">
        {line}
      </span>
    );
  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const from = size;
    onStart();
    deskDrag.next(true);
    const move = (ev: PointerEvent) => setDockSize(from + (y0 - ev.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      deskDrag.next(false);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Dock size"
      aria-valuenow={size}
      aria-valuemin={DOCK_ICON.min}
      aria-valuemax={DOCK_ICON.max}
      tabIndex={0}
      title="Drag up or down to resize the dock"
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        const by = e.key === "ArrowUp" || e.key === "ArrowRight" ? 4 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -4 : 0;
        if (!by) return;
        e.preventDefault();
        setDockSize(size + by);
      }}
      className="group/divider -mx-1 flex cursor-ns-resize touch-none items-center self-stretch rounded px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {line}
    </span>
  );
}

/**
 * VS Code in the dock, once kept there (from its icon's menu, the Launchpad's): code-server, outside the basePath, so
 * a raw link to a new tab, as its desktop icon is. Its menu takes it out of the dock, or off the desktop and back.
 */
function VsCodeDockItem({ size }: { size: number }) {
  const [{ removedIcons }] = useSubject(desk);
  const onDesktop = !removedIcons?.includes(VSCODE_ICON);
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <DockSlot label="VS Code" size={size}>
          <a href="/vscode/" target="_blank" rel="noreferrer" aria-label="VS Code" className="block outline-none focus-visible:rounded-[24%] focus-visible:ring-2 focus-visible:ring-ring">
            <VsCodeIcon size={size} />
          </a>
        </DockSlot>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => window.open("/vscode/", "_blank", "noreferrer")}>Open VS Code</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setPinned(VSCODE_ICON, false)}>Remove from Dock</ContextMenuItem>
        <ContextMenuItem onClick={() => setOnDesktop(VSCODE_ICON, !onDesktop)}>{onDesktop ? "Remove from Desktop" : "Add to Desktop"}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One place in the dock: it widens with its scale, its tile grows from the bottom, its name shows above on hover. */
function DockSlot({
  label,
  size,
  running,
  children,
}: {
  label: string;
  size: number;
  running?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-dock-item
      className="group relative shrink-0 transition-[width] duration-100 ease-out"
      style={{ width: `calc(var(--s, 1) * ${size}px)`, height: size }}
    >
      <div
        className="absolute bottom-0 left-1/2 origin-bottom transition-transform duration-100 ease-out"
        style={{ transform: "translateX(-50%) scale(var(--s, 1))" }}
      >
        {children}
      </div>
      <span
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-md bg-zinc-900/85 px-2 py-0.5 text-xs whitespace-nowrap text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100"
        style={{ bottom: `calc(var(--s, 1) * ${size}px + 10px)` }}
      >
        {label}
      </span>
      {running && (
        <span aria-hidden className="absolute -bottom-[7px] left-1/2 size-1 -translate-x-1/2 rounded-full bg-foreground/70" />
      )}
    </div>
  );
}

/* ------------------------------ the launchpad ----------------------------- */

/** Every app and every project, over a blur of the desktop; type to narrow, Enter opens the first. */
function Launchpad({ badgeOf }: { badgeOf: BadgeOf }) {
  const [on] = useSubject(launchpad);
  return on ? <LaunchpadOverlay badgeOf={badgeOf} /> : null;
}

function LaunchpadOverlay({ badgeOf }: { badgeOf: BadgeOf }) {
  const router = useRouter();
  const [{ pinned, removedIcons }] = useSubject(desk);
  const [q, setQ] = useState("");
  const [projects, setProjects] = useState<ProjectNavItem[] | null>(null);
  const close = () => launchpad.next(false);

  useEffect(() => {
    let active = true;
    fetch(`${BASE_PATH}/api/projects`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { projects?: ProjectNavItem[] } | null) => active && json?.projects && setProjects(json.projects))
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && launchpad.next(false);
    window.addEventListener("keydown", onKey);
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const ql = q.trim().toLowerCase();
  const apps = NAV_FLAT.filter((a) => !ql || a.label.toLowerCase().includes(ql) || a.href.slice(1).includes(ql));
  const projs = (projects ?? []).filter((p) => !ql || p.slug.toLowerCase().includes(ql));
  const projectHref = (slug: string) => `/projects/${encodeURIComponent(slug)}`;
  const go = () => {
    close();
    showWindow();
  };
  // a click on the backdrop (not on an app) closes it
  const onBackdrop = (e: React.MouseEvent) => e.target === e.currentTarget && close();

  const grid = "grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-2 gap-y-5";
  const tile =
    "group flex flex-col items-center gap-2 rounded-xl p-2 outline-none focus-visible:bg-white/15";
  const name =
    "max-w-full truncate text-xs font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]";
  const pop = "transition-transform duration-150 group-hover:scale-105 group-active:scale-95";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Launchpad"
      onClick={onBackdrop}
      style={{ zIndex: Z_LAUNCHPAD }}
      className="scrollbar-hover fixed inset-0 overflow-y-auto bg-zinc-950/40 backdrop-blur-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-105"
    >
      <div onClick={onBackdrop} className="mx-auto max-w-5xl px-6 pt-10 pb-16">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const first = apps[0]?.href ?? (projs[0] ? projectHref(projs[0].slug) : null);
            if (!first) return;
            go();
            router.push(first);
          }}
          className="mx-auto mb-10 max-w-xs"
        >
          <label className="flex items-center gap-2 rounded-lg bg-white/15 px-3 py-1.5 text-sm text-white ring-1 ring-white/25">
            <Search className="size-4 shrink-0 opacity-70" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps and projects"
              aria-label="Search apps and projects"
              className="w-full bg-transparent outline-none placeholder:text-white/60"
            />
          </label>
        </form>

        {apps.length > 0 && (
          <div onClick={onBackdrop} className={grid}>
            {apps.map((a) => (
              <LaunchpadMenu key={a.href} id={a.href} removed={!!removedIcons?.includes(a.href)} pinned={pinned.includes(a.href)}>
                <Link href={a.href} onClick={go} className={tile}>
                  <span className={pop}>
                    <AppIcon item={a} size={64} badge={badgeOf(a.href)} />
                  </span>
                  <span className={name}>{a.label}</span>
                </Link>
              </LaunchpadMenu>
            ))}
            {(!ql || "vs code".includes(ql)) && (
              <LaunchpadMenu id={VSCODE_ICON} removed={!!removedIcons?.includes(VSCODE_ICON)} pinned={pinned.includes(VSCODE_ICON)}>
                <a href="/vscode/" target="_blank" rel="noreferrer" onClick={close} className={tile}>
                  <span className={pop}>
                    <VsCodeIcon size={64} />
                  </span>
                  <span className={name}>VS Code</span>
                </a>
              </LaunchpadMenu>
            )}
          </div>
        )}

        {projs.length > 0 && (
          <>
            <h2 className="mt-12 mb-4 text-xs font-semibold tracking-wider text-white/75 uppercase">Projects</h2>
            <div onClick={onBackdrop} className={grid}>
              {projs.map((p) => (
                <Link
                  key={p.slug}
                  href={projectHref(p.slug)}
                  onClick={go}
                  title={`${p.slug}${p.running ? " · running" : ""} · ${p.openTasks} ticket${p.openTasks === 1 ? "" : "s"} to do`}
                  className={tile}
                >
                  <span className={pop}>
                    <ProjectIcon slug={p.slug} size={64} running={p.running} />
                  </span>
                  <span className={name}>{p.slug}</span>
                </Link>
              ))}
            </div>
          </>
        )}

        {!apps.length && !projs.length && (
          <p className="mt-16 text-center text-sm text-white/75">Nothing matches “{q}”.</p>
        )}
      </div>
    </div>
  );
}

/** An app's right-click menu in the Launchpad: on the desktop or off it (the way back for one removed), in the dock or not. */
function LaunchpadMenu({ id, removed, pinned, children }: { id: string; removed: boolean; pinned?: boolean; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" positionerStyle={{ zIndex: Z_LAUNCHPAD + 1 }}>
        <ContextMenuItem onClick={() => setOnDesktop(id, removed)}>{removed ? "Add to Desktop" : "Remove from Desktop"}</ContextMenuItem>
        {pinned !== undefined && <ContextMenuItem onClick={() => setPinned(id, !pinned)}>{pinned ? "Remove from Dock" : "Keep in Dock"}</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
