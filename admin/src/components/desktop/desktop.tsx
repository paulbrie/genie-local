"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  Check,
  ChevronRight,
  Code2,
  ExternalLink,
  Maximize2,
  Minimize2,
  Minus,
  RotateCw,
  SquareArrowDownLeft,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import { WISP_BODY, WISP_EYES } from "@/brand/spiridus";
import { AppIcon } from "@/components/desktop/app-icon";
import { openSettings } from "@/components/desktop/desktop-menu";
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
import {
  appOf,
  type Cell,
  type CellRect,
  cellsRect,
  clampRect,
  alignShift,
  defaultWidgetAt,
  type DeskAlign,
  type DeskSaved,
  dropRange,
  type Edges,
  fitShift,
  GRID,
  gridSize,
  LIVE_ID,
  liveFate,
  maxRect,
  popupStart,
  moveCells,
  NAV_ALWAYS,
  overlaps,
  placeWidgets,
  arrangementFits,
  stackDesktop,
  widgetWants,
  type Rect,
  type WinGeom,
  resizeCells,
  resizeRect,
  subPath,
  sideGlyph,
  unmaximizeUnder,
  VSCODE_NAV,
  WIDGET_LABEL,
  WIDGET_MIN,
  type WidgetId,
  widgetMode,
  WIDGETS,
} from "@/lib/desktop";
import { useIsMobile } from "@/lib/use-is-mobile";
import { openTerminal } from "@/store/terminals";
import { commandPalette } from "@/store/ui";
import {
  attachLive,
  closeAttached,
  closeLive,
  desk,
  hydrateDesk,
  liveFocus,
  liveToFrame,
  liveWin,
  setGeom,
  setArrangement,
  setNavShown,
  setWidgetAt,
  setWidgetMode,
  closeFrame,
  deskDrag,
  focusWin,
  frames,
  openFrame,
  raiseApp,
  stack,
  updateFrame,
  updateLive,
  type FrameWin,
} from "@/store/desktop";

const BY_HREF = new Map(NAV_FLAT.map((i) => [i.href, i]));

/**
 * Where the page goes: the content area beside the sidebar, under the top bar. The page shows there inline, scrolling
 * as a plain column; Home ("/") there is the wallpaper with its widgets; over the area float the pop-ups. The page
 * inline pops out live (the top bar's detach, desktop-menu.tsx): this very wrapper becomes its window, so nothing
 * remounts and nothing reloads (its scroll, what's typed in it, an open editor all stay), the URL stays its own and
 * Home draws behind; put back, it restyles inline. Where the route goes meanwhile decides the rest (liveFate): its own
 * way, the window follows; something else's (a sidebar click, ⌘K, a link elsewhere), it goes on in a frame at its
 * path, the new page inline. Pages opened in a new window are frames from the start (FrameWindows).
 *
 * The page sits at the same place in the tree inline or popped out, and what scrolls it is the same element either
 * way, so its scroll stays. Inline it has no z-index; each pop-up is a layer over it (winZ). On the login page
 * (`shell` false) it's the page alone.
 */
export function Workspace({ shell, children }: { shell: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mobile = useIsMobile();
  const areaRef = useRef<HTMLDivElement>(null);
  const [ws, setWs] = useState<{ w: number; h: number } | null>(null);
  const [live] = useSubject(liveWin);
  const [ownMove] = useSubject(liveFocus);
  const [list] = useSubject(frames);
  const [order] = useSubject(stack);
  const [{ geoms }] = useSubject(desk);
  const fate = shell && live ? liveFate(live, pathname, ownMove) : null;
  // the page in a window of its own (a phone's: the whole area)
  const floating = fate === "stay" || fate === "follow";
  // Home: the route's, or drawn behind the page floating (the home's page renders nothing)
  const atHome = shell && pathname === "/";
  const item = live?.app ? (BY_HREF.get(live.app) ?? null) : null;
  const area = ws ?? { w: 1024, h: 768 };
  // a first place: where its app's last pop-up was (or the default), a step down and right for each frame open
  const start = live?.geom ?? popupStart(live?.app ? geoms[live.app] : undefined, list.length, area.w, area.h);
  const winRef = useRef<HTMLDivElement>(null);
  const pop = usePopupMoves(winRef, start, area, mobile, (geom) => {
    updateLive({ geom });
    if (live?.app) setGeom(live.app, geom);
  }, () => focusWin(LIVE_ID));

  // Restore what this browser and tab remember, once the shell first shows (not on the login page).
  useEffect(() => {
    if (shell) hydrateDesk(NAV_HREFS, pathname);
    // (once: where the route is at that moment)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  useEffect(() => {
    const el = areaRef.current;
    if (!shell || !el) return;
    const ro = new ResizeObserver(() => setWs({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shell]);

  // Where the last press or key was: in the live window (where the route goes next is its own way) or elsewhere.
  useEffect(() => {
    if (!shell) return;
    const note = (e: Event) => {
      const inside = !!winRef.current?.contains(e.target as Node);
      if (inside !== liveFocus.getValue()) liveFocus.next(inside);
    };
    window.addEventListener("pointerdown", note, true);
    window.addEventListener("keydown", note, true);
    return () => {
      window.removeEventListener("pointerdown", note, true);
      window.removeEventListener("keydown", note, true);
    };
  }, [shell]);

  // The route moved: frames put back inline go (their page is here now); the live window follows, goes on in a
  // frame, or, closed, is gone (decided above, as it's drawn).
  useEffect(() => {
    if (!shell) return;
    closeAttached();
    const l = liveWin.getValue();
    if (!l) return;
    const f = liveFate(l, pathname, liveFocus.getValue());
    if (f === "follow") updateLive({ path: pathname + window.location.search, app: appOf(pathname, NAV_HREFS) });
    else if (f === "frame") liveToFrame();
    else if (f === "gone") attachLive();
  }, [shell, pathname]);

  // (its first place is kept: a frame of its app moving later doesn't move it)
  const placed = !!live?.geom;
  useEffect(() => {
    if (floating && !placed && ws) updateLive({ geom: start });
  }, [floating, placed, ws, start]);

  return (
    <div
      ref={areaRef}
      className={shell ? "relative min-h-0 flex-1 overflow-hidden" : "scrollbar-clear flex-1 overflow-y-auto"}
    >
      {(atHome || floating) && <DesktopBackground mobile={mobile} />}
      <div
        ref={winRef}
        role={floating ? "region" : undefined}
        aria-label={floating ? `${item?.label ?? "Page"} window` : undefined}
        aria-hidden={floating && live?.hidden ? true : undefined}
        onPointerDownCapture={floating ? () => focusWin(LIVE_ID) : undefined}
        style={floating ? { ...pop.style, zIndex: winZ(order, LIVE_ID), ...(ws ? {} : { visibility: "hidden" }) } : undefined}
        className={
          !shell
            ? "contents"
            : floating
              ? `${pop.className} ${live?.hidden ? "invisible" : ""}`
              : atHome
                ? "hidden"
                : "absolute inset-0 flex flex-col"
        }
      >
        {floating && live && (
          <TitleBar
            item={item}
            pathname={pathname}
            mobile={mobile}
            max={pop.max}
            onPointerDown={pop.onBarPointerDown}
            onClose={() => {
              closeLive();
              router.push("/");
            }}
            onMinimize={() => updateLive({ hidden: true })}
            onToggleMax={pop.toggleMax}
            onAttach={attachLive}
            onReload={() => router.refresh()}
            href={`${BASE_PATH}${live.path}`}
          />
        )}
        <div
          className={
            shell
              ? `scrollbar-clear min-h-0 flex-1 overflow-y-auto ${floating && !mobile ? "rounded-b-[calc(var(--radius)*1.4-1px)]" : ""} ${
                  floating && pop.dragging ? "pointer-events-none select-none" : ""
                }`
              : "contents"
          }
        >
          {atHome ? null : children}
        </div>
        {floating && !mobile && !pop.max && <ResizeHandles onPointerDown={pop.onResizePointerDown} />}
      </div>
      {shell && <FrameWindows area={ws} mobile={mobile} />}
    </div>
  );
}

/* ------------------------------- a pop-up ------------------------------- */

/**
 * A pop-up's place and its moves (the live page's window and the frames', `winRef`): its rect in the content area (`area`) from
 * `geom` (maximized: the whole area, a gap around it), dragged by its title bar (a maximized one comes back to its size
 * under the pointer), resized from any edge or corner, maximized and back with a glide; `save` keeps where it's let go,
 * `focus` brings it to the front when grabbed. A phone's fills the area and doesn't move.
 */
function usePopupMoves(
  winRef: React.RefObject<HTMLDivElement | null>,
  geom: WinGeom,
  area: { w: number; h: number },
  mobile: boolean,
  save: (g: WinGeom) => void,
  focus: () => void,
) {
  const [live, setLive] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [glide, setGlide] = useState(false);
  const { w: W, h: H } = area;
  const max = !!geom.max;
  const placed = clampRect(geom, W, H);
  const rect = live ?? (max ? maxRect(W, H) : placed);
  const saveGeom = (r: Rect, isMax = max) => save({ ...clampRect(r, W, H), ...(isMax ? { max: true } : {}) });

  function toggleMax() {
    if (mobile) return;
    setGlide(true);
    window.setTimeout(() => setGlide(false), 260);
    saveGeom(placed, !max);
  }

  function onBarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || mobile || (e.target as HTMLElement).closest("button, a, input")) return;
    focus();
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
    focus();
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

  const style: React.CSSProperties = mobile ? { inset: 0 } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  const className = `absolute flex origin-bottom flex-col bg-background motion-safe:animate-desk-in ${
    mobile ? "" : "rounded-xl border shadow-[0_28px_70px_-18px_rgb(0_0_0/0.5)] ring-1 ring-black/5 dark:ring-white/10"
  } ${glide && !dragging ? "transition-[left,top,width,height] duration-200 ease-out" : ""}`;
  return { max, dragging, style, className, toggleMax, onBarPointerDown, onResizePointerDown };
}

function TitleBar({
  item,
  pathname,
  mobile,
  max,
  onPointerDown,
  onClose,
  onMinimize,
  onToggleMax,
  onAttach,
  onReload,
  href,
}: {
  item: NavItem | null;
  pathname: string;
  mobile: boolean;
  max: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  /** back inline, in place of the page there */
  onAttach: () => void;
  onReload: () => void;
  /** its page's address, for a new browser tab */
  href: string;
}) {
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
        <Light color="bg-[#febc2e]" label="Minimize" onClick={onMinimize} glyph={Minus} mobile={mobile} />
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
        <button type="button" aria-label="Put back in the page" title="Put back in the page (in place of the one there)" onClick={onAttach} className={btn}>
          <SquareArrowDownLeft className="size-3.5" />
        </button>
        <button type="button" aria-label="Reload" title="Reload" onClick={onReload} className={btn}>
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Open in a new browser tab"
          title="Open in a new browser tab"
          onClick={() => window.open(href, "_blank", "noopener")}
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

/** A pop-up's layer: its place in the stack, back to front, from 1 (all under the phone's sidebar drawer, from 40). */
function winZ(order: string[], id: string): number {
  return Math.min(order.indexOf(id) + 1, 39);
}

/**
 * The pop-ups: each a page of the app in a frame (the page there renders alone, as app-shell's FramedPage), back to
 * front as `stack` says, each a layer at its place in it (winZ), over the content area.
 */
function FrameWindows({ area, mobile }: { area: { w: number; h: number } | null; mobile: boolean }) {
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
      else if (e.data.type === "spiridus:focus") {
        focusWin(id);
        // (a press in a frame is one outside the live window)
        liveFocus.next(false);
      }
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
        <FrameWindow key={f.id} win={f} z={winZ(order, f.id)} cascade={i} area={area} mobile={mobile} />
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
}: {
  win: FrameWin;
  z: number;
  cascade: number;
  area: { w: number; h: number };
  mobile: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const [{ geoms }] = useSubject(desk);
  // (the frame's first page: later ones it goes to itself, and its src mustn't follow, or it would reload)
  const [src] = useState(() => `${BASE_PATH}${win.path}`);
  const [dragAny] = useSubject(deskDrag);
  const item = win.app ? (BY_HREF.get(win.app) ?? null) : null;
  // a new one: where its app's last was (or the default), a step down and right for each one open before it
  const start = win.geom ?? popupStart(win.app ? geoms[win.app] : undefined, cascade, area.w, area.h);
  // its place, and where its app's next one opens
  const pop = usePopupMoves(winRef, start, area, mobile, (geom) => {
    updateFrame(win.id, { geom });
    if (win.app) setGeom(win.app, geom);
  }, () => focusWin(win.id));
  // (kept from the first: another of its app's moving later doesn't move this one)
  useEffect(() => {
    if (!win.geom) updateFrame(win.id, { geom: start });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back inline, in place of the page there: it stays over it until its page is there (Workspace closes it then), so
  // nothing flashes; its page already the route's (the live window's), that one goes back inline instead, as it is.
  function attach() {
    const bare = win.path.split("?")[0];
    if (bare === pathname) {
      closeFrame(win.id);
      if (liveWin.getValue()) attachLive();
      router.push(win.path);
      return;
    }
    liveFocus.next(false);
    updateFrame(win.id, { attaching: true });
    router.push(win.path);
  }

  const cw = () => frameRef.current?.contentWindow ?? null;
  return (
    <div
      ref={winRef}
      role="region"
      aria-label={`${item?.label ?? "Page"} window`}
      aria-hidden={win.hidden ? true : undefined}
      onPointerDownCapture={() => focusWin(win.id)}
      style={{ ...pop.style, zIndex: z }}
      className={`${pop.className} ${win.hidden ? "invisible" : ""}`}
    >
      <TitleBar
        item={item}
        pathname={win.path.split("?")[0]}
        mobile={mobile}
        max={pop.max}
        onPointerDown={pop.onBarPointerDown}
        onClose={() => closeFrame(win.id)}
        onMinimize={() => updateFrame(win.id, { hidden: true })}
        onToggleMax={pop.toggleMax}
        onAttach={attach}
        onReload={() => cw()?.location.reload()}
        href={`${BASE_PATH}${win.path}`}
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
      {!mobile && !pop.max && <ResizeHandles onPointerDown={pop.onResizePointerDown} />}
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
 * The wallpaper and its widgets (WidgetGrid). On a phone the widgets go one a row, the whole width: there, the
 * sidebar's drawer is the way to the apps.
 */
function DesktopBackground({ mobile }: { mobile: boolean }) {
  const [{ widgets, align }] = useSubject(desk);
  return (
    <>
      <Wallpaper />
      <WidgetGrid widgets={widgets} align={align ?? "left"} stacked={mobile} />
    </>
  );
}

/**
 * The desktop's widgets on a grid (lib/desktop.ts): each takes a span of cells (WidgetFrame; deskWidgets, desk.widgets),
 * dragged and resized on it. The whole arrangement is drawn against the left, centred or against the right
 * (alignShift; desk.align), as it is. A right-click on the wallpaper (not on a widget) opens the desktop's menu
 * (DeskMenu).
 */
function WidgetGrid({
  widgets,
  align,
  stacked,
}: {
  widgets: DeskSaved["widgets"];
  align: DeskAlign;
  /** one a row whatever the width (a phone's) */
  stacked: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // the desktop's menu: where it was opened, and the spot under it (a widget added from it goes there)
  const [menu, setMenu] = useState<{ x: number; y: number; cell: Cell } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The arrangement glides only to settle a drop that moves it over (to keep it on the grid); placed any other way
  // (the first measure, the saved arrangement restored, a resize) it's simply there.
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
  const { cols, rows: fitRows } = size ? gridSize(size.w, size.h) : { cols: 1, rows: 1 };
  // (widgets put further right than a narrower window has room for, but no wider than it: moved over together, as a
  // drop past the edge moves them, so they keep where they are to each other rather than one being pushed in alone)
  const wants = useMemo(() => {
    const ws = widgetWants(widgets, cols);
    const dc = fitShift(ws.filter((w) => w.custom).map((w) => w.at), cols);
    return dc ? ws.map((w) => (w.custom ? { ...w, at: { ...w.at, c: w.at.c + dc } } : w)) : ws;
  }, [widgets, cols]);
  // A window shorter than the arrangement doesn't squeeze it (widgets pushed up onto each other): the grid has the
  // rows it needs, the desktop grows below the window, and scrolls. (Narrower, it stacks instead: below.)
  const rows = Math.max(fitRows, ...wants.map((w) => w.at.r + w.at.h));
  const placed = useMemo(() => placeWidgets(wants, cols, rows) as Partial<Record<WidgetId, CellRect>>, [wants, cols, rows]);
  const blocked = useMemo(() => Object.values(placed).filter((r): r is CellRect => !!r), [placed]);
  // (the rows it all takes: the desktop's height, to scroll; a widget with no room on the grid goes under it)
  const usedRows = Math.max(rows, ...blocked.map((b) => b.r + b.h));
  // A window too narrow for the widgets as they were put (wider, from the first's left edge to the last's right edge,
  // than it is), or a phone: the desktop stacks, the widgets one a row the whole width, and it scrolls; nothing moves
  // by hand until there's room again, when the arrangement is back as it was.
  const stack = useMemo(() => (size && (stacked || !arrangementFits(wants, cols)) ? stackDesktop(wants, W) : null), [size, stacked, wants, cols, W]);
  /** the widgets but `skip` (the one being moved) */
  const spansBut = (skip?: WidgetId) => WIDGETS.flatMap((id) => (id !== skip && placed[id] ? [placed[id]] : []));
  // (everything below is in the arrangement's own coordinates: the layer it's drawn in is `shift` px right)
  const shift = size && !stack ? alignShift(align, spansBut(), W) : 0;

  /** a folded widget's span as saved: the height it unfolds to */
  const fullAt = (id: WidgetId, at: CellRect): CellRect =>
    widgetMode(widgets, id) === "collapsed" ? { ...at, h: (widgets?.[id]?.at ?? defaultWidgetAt(id, cols)).h } : at;
  // A drop keeps the arrangement on the grid: one left of its first column (or right of its last) moves the whole of
  // it over by as much, so nothing moves on screen but what was dropped.
  const commit = (moved: { id: WidgetId; at: CellRect }) => {
    const wids: Partial<Record<WidgetId, CellRect>> = { ...placed, [moved.id]: moved.at };
    const dc = fitShift(Object.values(wids).filter((r): r is CellRect => !!r), cols);
    settle();
    if (!dc) {
      setWidgetAt(moved.id, fullAt(moved.id, moved.at));
      return;
    }
    setArrangement(Object.fromEntries(WIDGETS.flatMap((id) => (wids[id] ? [[id, { ...fullAt(id, wids[id]), c: wids[id].c + dc }]] : []))));
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
        // (a widget's own menu is its)
        if ((e.target as HTMLElement).closest("aside")) return;
        e.preventDefault();
        const b = box.current!.getBoundingClientRect();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          cell: {
            c: Math.min(Math.max(Math.floor((e.clientX - b.left - shift - GRID.pad) / GRID.x), 0), cols - 1),
            r: Math.min(Math.max(Math.floor((e.clientY - b.top + box.current!.scrollTop - GRID.pad) / GRID.y), 0), rows - 1),
          },
        });
      }}
    >
      <div
        className={`absolute top-0 ${glide ? "transition-[left] duration-200 ease-out" : ""}`}
        style={{ left: shift, width: W, height: Math.max(size?.h ?? 0, GRID.pad * 2 + (stack ? stack.rows : usedRows) * GRID.y) }}
      >
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
              rows={usedRows}
              moveCols={dropRange(others, at.w, cols, shift, W)}
              sizeCols={{ lo: cell.lo, hi: cell.hi + 1 }}
              others={blocked.filter((b) => b !== at)}
              onPlace={(to) => commit({ id, at: to })}
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
 * The desktop's own right-click menu (on the wallpaper, not on a widget), as macOS's: each widget, ticked when it's on
 * the desktop (a click puts it where the menu was opened, or takes it off), then Settings. Closes on a click
 * elsewhere, Escape, or the window losing focus.
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
      aria-label="Home"
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
      <button type="button" role="menuitem" onClick={pick(() => openSettings((href) => router.push(href)))} className={row}>
        Settings…
      </button>
    </div>,
    document.body,
  );
}

/**
 * A widget on the desktop's grid (WidgetGrid): dragged anywhere by its header ([data-widget-grip]), resized from any
 * edge or corner down to WIDGET_MIN (three cells by three). Either way it follows the pointer with the span it will
 * take outlined (red where it would cover the other widget: let go there, it goes back), and settles on that span when
 * let go. Folded, it's one row of the grid tall (its header as a glance), and only moves.
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
      to: moveCells(at, dx / GRID.x, dy / GRID.y, moveCols, rows),
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
        to: resizeCells(at, edges, dx / GRID.x, dy / GRID.y, sizeCols, rows),
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

/**
 * An app's right-click menu in the sidebar (`children`: more of its own), "Hide from sidebar" last
 * (Settings → General has them all; the home and Settings stay). No new window on a phone (`onNewWindow` absent).
 */
function AppMenu({
  href,
  label,
  windows,
  onOpen,
  onNewWindow,
  onNewTab,
  onClose,
  children,
}: {
  href: string;
  label: string;
  /** how many pop-ups it has (onClose closes them) */
  windows: number;
  onOpen: () => void;
  onNewWindow?: () => void;
  onNewTab: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onClick={onOpen}>Open {label}</ContextMenuItem>
      {onNewWindow && <ContextMenuItem onClick={onNewWindow}>Open in a new window</ContextMenuItem>}
      <ContextMenuItem onClick={onNewTab}>Open in a new browser tab</ContextMenuItem>
      {windows > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onClose}>{windows > 1 ? `Close its ${windows} windows` : "Close its window"}</ContextMenuItem>
        </>
      )}
      {children && (
        <>
          <ContextMenuSeparator />
          {children}
        </>
      )}
      {!NAV_ALWAYS.includes(href) && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setNavShown(href, false)}>Hide from sidebar</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

/* ------------------------------- the sidebar ------------------------------- */

/** A row of the sidebar (as tall as the size picked, 32 px at the default). */
function sideRow(active: boolean, rail: boolean) {
  return `relative flex min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1 leading-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
    rail ? "justify-center" : ""
  } ${active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`;
}

/** The names' size beside icons of `size` px: 13 px, a little more with the bigger ones. */
const sideFont = (size: number) => Math.max(13, Math.round(10 + size / 8));

/** An icon in the sidebar: its glyph, in the row's colour (sideGlyph: 15 px at the default size), the row `size` tall. */
function SideIcon({ icon: Icon, size }: { icon: NavItem["icon"]; size: number }) {
  const px = sideGlyph(size);
  return (
    <span className="flex shrink-0 items-center" style={{ height: size }}>
      <Icon className="shrink-0" style={{ width: px, height: px }} />
    </span>
  );
}

/** A count on a row of the icon rail (which has no room for the row's own). */
function RailBadge({ count }: { count: number }) {
  return (
    <span className="absolute -top-1 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
      {count}
    </span>
  );
}

/**
 * An app in the sidebar (app-sidebar.tsx): its icon at the sidebar's size (desk.sidebarSize), a dot by it while it's
 * popped out. A click shows its page inline, unless it's popped out: then its window comes to the front (raiseApp); a
 * click with a modifier is the browser's (onNavigate isn't called). Right-click: open it, in a new window (not on a
 * phone) or tab, close its windows, `menu` (its own), hide it from the sidebar. Home is the wallpaper with its widgets,
 * a page like the others (as it is while a page floats over it, live).
 */
export function DeskNavLink({
  item,
  size,
  rail,
  active,
  badge,
  indent = 0,
  onClick,
  menu,
  children,
}: {
  item: NavItem;
  size: number;
  rail: boolean;
  /** its page is the one inline */
  active: boolean;
  /** a count by the icon (on the rail, which has no room for the row's own) */
  badge?: number | null;
  /** px further in (a group's item) */
  indent?: number;
  onClick?: () => void;
  menu?: React.ReactNode;
  /** after its name: a count, a badge */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const mobile = useIsMobile();
  const [wins] = useSubject(frames);
  const [live] = useSubject(liveWin);
  const href = item.href;
  const home = href === "/";
  const label = item.label;
  const appFrames = home ? [] : wins.filter((f) => f.app === href);
  // popped out: in frames, or live
  const out = appFrames.length > 0 || (!home && live?.app === href);

  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? label : undefined}
      title={rail ? `${label}${badge ? ` (${badge})` : ""}` : undefined}
      onClick={onClick}
      onNavigate={(e) => {
        // (Home: as it is while a page floats over it, live)
        if (home ? !!liveWin.getValue() : raiseApp(href)) e.preventDefault();
      }}
      className={`flex-1 ${sideRow(active, rail)}`}
      style={{ fontSize: sideFont(size), paddingLeft: indent ? 10 + indent : undefined }}
    >
      {out && (
        <span aria-hidden className="absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-foreground/60" style={{ left: indent }} />
      )}
      <SideIcon icon={item.icon} size={size} />
      {rail && badge != null && <RailBadge count={badge} />}
      {!rail && <span className="truncate">{label}</span>}
      {!rail && children}
    </Link>
  );
  if (home) return link;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex min-w-0 flex-1">{link}</ContextMenuTrigger>
      <AppMenu
        href={href}
        label={item.label}
        windows={appFrames.length}
        onOpen={() => {
          if (!raiseApp(href)) router.push(href);
        }}
        onNewWindow={mobile ? undefined : () => openFrame(href, href)}
        onNewTab={() => window.open(`${BASE_PATH}${href}`, "_blank", "noopener")}
        onClose={() => {
          for (const f of appFrames) closeFrame(f.id);
        }}
      >
        {menu}
      </AppMenu>
    </ContextMenu>
  );
}

/**
 * VS Code in the sidebar: code-server, outside the basePath, so a raw link to a new tab. Its menu hides it from the
 * sidebar.
 */
export function DeskVsCodeLink({ size, rail, onClick }: { size: number; rail: boolean; onClick?: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex min-w-0">
        <a
          href="/vscode/"
          target="_blank"
          rel="noreferrer"
          onClick={onClick}
          aria-label={rail ? "VS Code" : undefined}
          title={rail ? "VS Code" : undefined}
          className={`flex-1 ${sideRow(false, rail)}`}
          style={{ fontSize: sideFont(size) }}
        >
          <SideIcon icon={Code2} size={size} />
          {!rail && (
            <>
              <span className="truncate">VS Code</span>
              <ExternalLink className="ml-auto size-3.5 shrink-0 opacity-50" />
            </>
          )}
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => window.open("/vscode/", "_blank", "noreferrer")}>Open VS Code</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setNavShown(VSCODE_NAV, false)}>Hide from sidebar</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
