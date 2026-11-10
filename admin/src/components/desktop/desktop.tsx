"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  ChevronLeft,
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
  clampRect,
  defaultGeom,
  DOCK_SPACE,
  type Edges,
  maxRect,
  type Rect,
  resizeRect,
  subPath,
  unmaximizeUnder,
} from "@/lib/desktop";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useNavBadges } from "@/lib/use-nav-badges";
import { Z_LAUNCHPAD } from "@/lib/z-layers";
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
 * The window has no transform, filter or z-index of its own: a page's own
 * `fixed` panels stay relative to the viewport, and its z-indexes keep working
 * against the rest of the app as they do in classic.
 */
export function Workspace({ desktop, children }: { desktop: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mobile = useIsMobile();
  const areaRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const [ws, setWs] = useState<{ w: number; h: number } | null>(null);
  const [{ geoms }] = useSubject(desk);
  const [{ hidden }] = useSubject(deskView);
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
  useEffect(() => {
    if (!desktop || hydrated.current) return;
    hydrated.current = true;
    hydrateDesk(NAV_HREFS);
  }, [desktop]);

  // The page you go to is the window in front (and its app open, at that path).
  useEffect(() => {
    if (!desktop) return;
    if (app) noteApp(app, pathname + window.location.search);
    showWindow();
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
        if (max) start = unmaximizeUnder(saved ? clampRect(saved, W, H) : defaultGeom(W, H), r0, x0 - area.getBoundingClientRect().left);
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
          ? maxRect(ws.w, ws.h)
          : clampRect(saved ?? defaultGeom(ws.w, ws.h), ws.w, ws.h)
        : saved && !max
          ? saved
          : null));
  const winStyle: React.CSSProperties | undefined = !desktop
    ? undefined
    : mobile
      ? { inset: 0 }
      : rect
        ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
        : max
          ? { left: 8, top: 8, right: 8, bottom: DOCK_SPACE }
          : { top: 12, right: 16, bottom: DOCK_SPACE };

  return (
    <div
      ref={areaRef}
      className={desktop ? "relative min-h-0 flex-1 overflow-hidden" : "flex-1 overflow-y-auto"}
    >
      {desktop && <DesktopBackground mobile={mobile} badgeOf={badgeOf} />}
      <div
        ref={winRef}
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
              ? `min-h-0 flex-1 overflow-y-auto ${mobile ? "" : "rounded-b-[calc(var(--radius)*1.4-1px)]"} ${dragging ? "pointer-events-none select-none" : ""}`
              : "contents"
          }
        >
          {desktop && hidden === "closed" ? null : children}
        </div>
        {desktop && !mobile && !max && <ResizeHandles onPointerDown={onResizePointerDown} />}
      </div>
      {desktop && (
        <Dock app={app} mobile={mobile} windowShown={!hidden} badgeOf={badgeOf} onMinimize={minimize} />
      )}
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
}: {
  item: NavItem | null;
  pathname: string;
  mobile: boolean;
  max: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
}) {
  const router = useRouter();
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
      <button type="button" aria-label="Back" title="Back" onClick={() => router.back()} className={`z-10 ${btn}`}>
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" aria-label="Forward" title="Forward" onClick={() => router.forward()} className={`z-10 ${btn}`}>
        <ChevronRight className="size-4" />
      </button>

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
        <button type="button" aria-label="Reload" title="Reload" onClick={() => router.refresh()} className={btn}>
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Open in a new browser tab"
          title="Open in a new browser tab"
          onClick={() => window.open(`${BASE_PATH}${pathname}${window.location.search}`, "_blank", "noopener")}
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

/** Every app as an icon on the wallpaper, in columns from the top left (a phone's home screen on mobile). */
function DesktopBackground({ mobile, badgeOf }: { mobile: boolean; badgeOf: BadgeOf }) {
  const [{ pinned }] = useSubject(desk);
  const [open] = useSubject(openApps);
  return (
    <>
      <Wallpaper />
      <nav
        aria-label="Apps"
        className={
          mobile
            ? "scrollbar-hover absolute inset-0 grid auto-rows-[96px] grid-cols-4 content-start justify-items-center overflow-y-auto p-3 pb-28"
            : "absolute inset-0 grid auto-cols-[88px] grid-flow-col grid-rows-[repeat(auto-fill,96px)] content-start justify-start gap-x-1 p-3"
        }
        style={mobile ? undefined : { paddingBottom: DOCK_SPACE }}
      >
        {NAV_FLAT.map((it) => (
          <DeskIcon
            key={it.href}
            item={it}
            badge={badgeOf(it.href)}
            pinned={pinned.includes(it.href)}
            path={open.find((o) => o.app === it.href)?.path ?? it.href}
          />
        ))}
        {/* VS Code (code-server) lives outside the basePath: a raw <a>, gated by nginx. */}
        <a
          href="/vscode/"
          target="_blank"
          rel="noreferrer"
          className="group flex w-[84px] flex-col items-center gap-1 rounded-lg p-1.5 outline-none focus-visible:bg-white/25 dark:focus-visible:bg-white/10"
        >
          <span className="transition-transform duration-150 group-hover:-translate-y-0.5 group-active:scale-95">
            <VsCodeIcon size={52} />
          </span>
          <IconLabel>VS Code</IconLabel>
        </a>
      </nav>
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
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Link
          href={path}
          onClick={showWindow}
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
        label={item.label}
        pinned={pinned}
        onOpen={() => {
          showWindow();
          router.push(path);
        }}
        onNewTab={() => window.open(`${BASE_PATH}${path}`, "_blank", "noopener")}
        onPin={() => setPinned(item.href, !pinned)}
      />
    </ContextMenu>
  );
}

/** An app's right-click menu, on the desktop and in the dock. */
function AppMenu({
  label,
  pinned,
  onOpen,
  onNewTab,
  onPin,
  onClose,
}: {
  label: string;
  pinned: boolean;
  onOpen: () => void;
  onNewTab: () => void;
  onPin: () => void;
  onClose?: () => void;
}) {
  return (
    <ContextMenuContent className="w-48">
      <ContextMenuItem onClick={onOpen}>Open {label}</ContextMenuItem>
      <ContextMenuItem onClick={onNewTab}>Open in a new tab</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onPin}>{pinned ? "Remove from Dock" : "Keep in Dock"}</ContextMenuItem>
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

const DOCK_ICON = 48;
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
  const [{ pinned }] = useSubject(desk);
  const [open] = useSubject(openApps);
  const [pad] = useSubject(launchpad);
  const dockRef = useRef<HTMLDivElement>(null);
  const centers = useRef<{ el: HTMLElement; c: number }[]>([]);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const extra = open.map((o) => o.app).filter((a) => !pinned.includes(a));
  const size = mobile ? DOCK_ICON_MOBILE : DOCK_ICON;

  // On a phone the open window has the whole screen; the dock is for the home screen.
  if (mobile && windowShown) return null;

  const measure = () => {
    centers.current = [...(dockRef.current?.querySelectorAll<HTMLElement>("[data-dock-item]") ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, c: r.left + r.width / 2 };
    });
  };
  const onMove = (e: React.PointerEvent) => {
    if (mobile || e.pointerType === "touch") return;
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

  const appItem = (href: string) => {
    const it = BY_HREF.get(href);
    if (!it) return null;
    const entry = open.find((o) => o.app === href);
    const isPinned = pinned.includes(href);
    const path = entry?.path ?? href;
    return (
      <ContextMenu key={href}>
        <ContextMenuTrigger>
          <DockSlot label={it.label} size={size} running={!!entry}>
            <Link
              href={path}
              aria-label={it.label}
              onClick={(e) => {
                // the app in front: its window goes down to the dock (as a taskbar does)
                if (href === app && windowShown) {
                  e.preventDefault();
                  onMinimize();
                } else showWindow();
              }}
              className="block outline-none focus-visible:rounded-[24%] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AppIcon item={it} size={size} badge={badgeOf(href)} />
            </Link>
          </DockSlot>
        </ContextMenuTrigger>
        <AppMenu
          label={it.label}
          pinned={isPinned}
          onOpen={() => {
            showWindow();
            router.push(path);
          }}
          onNewTab={() => window.open(`${BASE_PATH}${path}`, "_blank", "noopener")}
          onPin={() => setPinned(href, !isPinned)}
          onClose={
            entry
              ? () => {
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
        <span aria-hidden className="mx-0.5 h-9 w-px self-center bg-foreground/15" />
        {pinned.map(appItem)}
        {extra.length > 0 && <span aria-hidden className="mx-0.5 h-9 w-px self-center bg-foreground/15" />}
        {extra.map(appItem)}
      </div>
    </div>
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
              <Link key={a.href} href={a.href} onClick={go} className={tile}>
                <span className={pop}>
                  <AppIcon item={a} size={64} badge={badgeOf(a.href)} />
                </span>
                <span className={name}>{a.label}</span>
              </Link>
            ))}
            {(!ql || "vs code".includes(ql)) && (
              <a href="/vscode/" target="_blank" rel="noreferrer" onClick={close} className={tile}>
                <span className={pop}>
                  <VsCodeIcon size={64} />
                </span>
                <span className={name}>VS Code</span>
              </a>
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
