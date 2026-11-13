// Pure, dependency-free: safe for server and client.
/**
 * The desktop shell (components/desktop): the app a path belongs to, the pop-up
 * windows' geometry over the content area (the area beside the sidebar, under
 * the top bar) and what a tab remembers of them, the sidebar's sizes, the
 * widgets' grid. Pure, so it is unit-tested; the components do the storage and
 * the DOM.
 */

/**
 * The app a path belongs to: the longest app href it is, or sits under ("/" only
 * itself). /projects/shop/git is Projects; /teams/x is Team.
 */
export function appOf(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const h of hrefs) {
    const hit = h === "/" ? pathname === "/" : pathname === h || pathname.startsWith(`${h}/`);
    if (hit && (!best || h.length > best.length)) best = h;
  }
  return best;
}

/** Whether page `p` (a path, maybe with a query) is `path` or under it: /projects/shop/git is under /projects/shop. */
export function pathUnder(p: string, path: string): boolean {
  const bare = p.split("?")[0];
  return bare === path || (path !== "/" && bare.startsWith(`${path}/`));
}

/** The path under an app, as the window's title shows it: /projects/shop/git → ["shop", "git"]. */
export function subPath(pathname: string, app: string | null): string[] {
  const rest = app && app !== "/" ? pathname.slice(app.length) : app === "/" ? "" : pathname;
  return rest
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export type Rect = { x: number; y: number; w: number; h: number };
/** A window's place: its restored rect, and whether it is maximized instead. */
export type WinGeom = Rect & { max?: boolean };

/**
 * A pop-up window as its tab remembers it (sessionStorage): the page it shows (of `app`; a page outside every app:
 * null), its place once moved, minimized or not.
 */
export type PopupSaved = { id: string; app: string | null; path: string; geom?: WinGeom; hidden?: boolean };

/**
 * The page inline popped out live: the route's own page in a window, kept as it is (no reload). Its path (with the
 * query it had), app, place once set, minimized or not; `closing`: closed, on its way out (never stored).
 */
export type LiveSaved = { path: string; app: string | null; geom?: WinGeom; hidden?: boolean; closing?: boolean };

/**
 * What becomes of the page popped out live when the route is at `pathname`: it stays (it's still its page; closed, it
 * stays out of sight until the route is Home), follows (it went there itself: the last press or key, `ownMove`, was in
 * it), goes on in a frame at its old path (something else took the route: a sidebar click, ⌘K, a link elsewhere), or is
 * gone (closed, and Home is here).
 */
export function liveFate(live: LiveSaved, pathname: string, ownMove: boolean): "stay" | "follow" | "frame" | "gone" {
  if (live.closing) return pathname === "/" ? "gone" : "stay";
  if (live.path.split("?")[0] === pathname) return "stay";
  return ownMove ? "follow" : "frame";
}

/** The smallest a window gets. */
export const MIN_WIN = { w: 380, h: 240 };
/** How much of a window's title bar has to stay on screen. */
const GRIP = 96;
/** The gap around a maximized window. */
const MAX_GAP = 8;

// (the content area is right of the sidebar and under the top bar: the pop-ups float over it, and over nothing else)

/** A pop-up where it first opens: centred over the content area, smaller than it, so it reads as a window. */
export function defaultGeom(W: number, H: number): Rect {
  const w = Math.round(Math.min(W - 48, Math.max(MIN_WIN.w, W * 0.7)));
  const h = Math.round(Math.min(H - 24, Math.max(MIN_WIN.h, H * 0.8)));
  return clampRect({ x: Math.round((W - w) / 2), y: Math.round((H - h) / 3), w, h }, W, H);
}

/**
 * Where a pop-up opens: where its app's last one was (`saved`, kept per app; maximized, it is again), else the
 * default; `n` steps down and right for the pop-ups open before it, so they don't land on each other; on screen.
 */
export function popupStart(saved: WinGeom | undefined, n: number, W: number, H: number): WinGeom {
  const base = saved ? clampRect(saved, W, H) : defaultGeom(W, H);
  const step = 28 * (n % 6);
  return { ...clampRect({ ...base, x: base.x + step, y: base.y + step }, W, H), ...(saved?.max ? { max: true } : {}) };
}

/** The maximized rect: the whole content area, a small gap around it. */
export function maxRect(W: number, H: number): Rect {
  return {
    x: MAX_GAP,
    y: MAX_GAP,
    w: Math.max(0, W - 2 * MAX_GAP),
    h: Math.max(0, H - 2 * MAX_GAP),
  };
}

/** The live page's window's id in the pop-ups' order (the frames' are generated, never this). */
export const LIVE_ID = "live";

/** Of the pop-ups `ids`, the one nearest the front (`order`: every pop-up's id, back to front); null for none. */
export function frontmost(order: readonly string[], ids: readonly string[]): string | null {
  for (let i = order.length - 1; i >= 0; i--) if (ids.includes(order[i])) return order[i];
  return ids[ids.length - 1] ?? null;
}

/**
 * Keep a window usable in a W × H workspace: no bigger than it (nor smaller than
 * the minimum, when it fits), its top on screen and enough of its title bar
 * showing to drag it back.
 */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = Math.round(Math.min(Math.max(r.w, Math.min(MIN_WIN.w, W)), W));
  const h = Math.round(Math.min(Math.max(r.h, Math.min(MIN_WIN.h, H)), H));
  const grip = Math.min(GRIP, w);
  const x = Math.round(Math.min(Math.max(r.x, grip - w), W - grip));
  const y = Math.round(Math.min(Math.max(r.y, 0), Math.max(0, H - 36)));
  return { x, y, w, h };
}

/** Which sides a resize handle moves. */
export type Edges = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };

/** A rect resized from `start` by dragging `edges` (dx, dy), kept at least `min` (a window's: MIN_WIN) and inside the workspace's top/left. */
export function resizeRect(start: Rect, edges: Edges, dx: number, dy: number, W: number, H: number, min: { w: number; h: number } = MIN_WIN): Rect {
  let { x, y, w, h } = start;
  if (edges.r) w = Math.min(Math.max(min.w, start.w + dx), W - start.x);
  if (edges.b) h = Math.min(Math.max(min.h, start.h + dy), H - start.y);
  if (edges.l) {
    const nx = Math.min(Math.max(0, start.x + dx), start.x + start.w - min.w);
    w = start.w + (start.x - nx);
    x = nx;
  }
  if (edges.t) {
    const ny = Math.min(Math.max(0, start.y + dy), start.y + start.h - min.h);
    h = start.h + (start.y - ny);
    y = ny;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Restoring a maximized window by dragging its title bar: the restored size,
 * placed so the point grabbed stays under the pointer at the same fraction of
 * the bar, its top where the maximized one's was.
 */
export function unmaximizeUnder(restored: Rect, max: Rect, px: number): Rect {
  const frac = max.w > 0 ? Math.min(Math.max((px - max.x) / max.w, 0), 1) : 0.5;
  return { ...restored, x: Math.round(px - frac * restored.w), y: max.y };
}

/* -------------------------- the sidebar, in the desktop -------------------------- */

/**
 * The sidebar's rows, in px (each as tall as this, plus its padding): by default, and how
 * small or big Settings makes them.
 */
export const SIDEBAR_ICON = { min: 16, max: 40, default: 24 } as const;

/** VS Code (code-server, outside the app's pages): its key among the sidebar's items. */
export const VSCODE_NAV = "vscode";

/** The sidebar's items never left out of it (Settings → General → Sidebar): the home, and Settings, where the rest come back. */
export const NAV_ALWAYS: readonly string[] = ["/", "/settings"];

/** Whether the sidebar shows item `id` (an app's href, or VSCODE_NAV), with `hidden` left out. */
export function navShown(hidden: readonly string[] | undefined, id: string): boolean {
  return NAV_ALWAYS.includes(id) || !hidden?.includes(id);
}

/** The icon on a row of `size` px: its glyph, 15 px by default. */
export function sideGlyph(size: number): number {
  return Math.round((size * 15) / SIDEBAR_ICON.default);
}

/**
 * The sidebar's width with rows of `size` px, with the names or as an icon rail (224 and 56 px at the default): each
 * icon plus the rows' and the list's padding, its border and a thin scrollbar's width.
 */
export function sidebarWidth(size: number, rail: boolean): number {
  return sideGlyph(size) + (rail ? 41 : 209);
}

/** What the desktop remembers on this browser (localStorage). */
export type DeskSaved = {
  /** Where each app's pop-up window opens next (its last one's place), by app href. */
  geoms: Record<string, WinGeom>;
  /** The widgets on the wallpaper, by id: where each is and how big (absent: its default spot), folded or hidden (absent: open). */
  widgets?: Partial<Record<WidgetId, WidgetSaved>>;
  /** The sidebar's icon size in the desktop, in px (absent: SIDEBAR_ICON.default). */
  sidebarSize?: number;
  /** Where the widgets sit across the desktop, as one arrangement: absent is against the left. */
  align?: "center" | "right";
  /** The sidebar's items left out of it (by app href, and VSCODE_NAV; never NAV_ALWAYS's). */
  hiddenNav?: string[];
};

export type DeskAlign = "left" | "center" | "right";

/**
 * The desktop's widgets: the terminals, the projects, the disk, the memory, the processes and Docker, and the ones that start off
 * (WIDGETS_OFF: a right-click on the desktop adds them): the services' health, the production errors, the repos'
 * state, the load, the tickets and the sign-ins.
 */
export const WIDGETS = ["terminals", "projects", "disk", "memory", "processes", "docker", "health", "errors", "git", "load", "tickets", "signins"] as const;
export type WidgetId = (typeof WIDGETS)[number];
export const WIDGET_LABEL: Record<WidgetId, string> = {
  terminals: "Terminals",
  projects: "Projects",
  disk: "Disk",
  memory: "Memory",
  processes: "Processes",
  docker: "Docker",
  health: "Health",
  errors: "Production errors",
  git: "Git",
  load: "Load",
  tickets: "Tickets",
  signins: "Sign-ins",
};
/** The app each widget is a glance at, where there's one: its header has the app's icon, to open it. */
export const WIDGET_APP: Partial<Record<WidgetId, string>> = {
  terminals: "/terminals",
  projects: "/projects",
  processes: "/processes",
  docker: "/docker",
  health: "/services",
  tickets: "/tasks",
  signins: "/logins",
};

/** The widgets off the desktop until they're put on it. */
export const WIDGETS_OFF: ReadonlySet<WidgetId> = new Set(["health", "errors", "git", "load", "tickets", "signins"]);

export type WidgetMode = "open" | "collapsed" | "hidden";

/**
 * A widget as remembered: absent `mode` is its default (WIDGETS_OFF: hidden; else open); `views`, its own choices of
 * how to show, by name (the Disk's chart, the Memory's split and period).
 */
export type WidgetSaved = { at?: CellRect; mode?: WidgetMode; views?: Record<string, string> };

/** What a widget is now: open, folded or off the desktop (its default when nothing says). */
export function widgetMode(saved: DeskSaved["widgets"], id: WidgetId): WidgetMode {
  return saved?.[id]?.mode ?? (WIDGETS_OFF.has(id) ? "hidden" : "open");
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A stored desktop, kept to the apps that still exist; anything unreadable gives the defaults. (What's gone is let go:
 * the dock's apps, the desktop's icons and the ones taken off it; the dock's size carries over to the sidebar's, at
 * the same place in the range: half.)
 */
export function parseDesk(raw: string | null, apps: readonly string[]): DeskSaved {
  const known = new Set(apps);
  const out: DeskSaved = { geoms: {} };
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const s = v as Record<string, unknown>;
  const widgets = parseWidgets(s);
  if (widgets) out.widgets = widgets;
  if (Array.isArray(s.hiddenNav)) {
    const hidden = [
      ...new Set(s.hiddenNav.filter((id): id is string => typeof id === "string" && (known.has(id) || id === VSCODE_NAV) && !NAV_ALWAYS.includes(id))),
    ];
    if (hidden.length) out.hiddenNav = hidden;
  }
  const side = s.sidebarSize ?? (Number.isInteger(s.dockSize) ? Math.round((s.dockSize as number) / 2) : undefined);
  if (Number.isInteger(side) && (side as number) >= SIDEBAR_ICON.min && (side as number) <= SIDEBAR_ICON.max) out.sidebarSize = side as number;
  if (s.align === "center" || s.align === "right") out.align = s.align;
  if (s.geoms && typeof s.geoms === "object" && !Array.isArray(s.geoms))
    for (const [app, g] of Object.entries(s.geoms as Record<string, unknown>)) {
      if (!known.has(app) || !g || typeof g !== "object") continue;
      const { x, y, w, h, max } = g as Record<string, unknown>;
      if (finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0)
        out.geoms[app] = { x, y, w, h, ...(max === true ? { max: true } : {}) };
    }
  return out;
}

/** A window's place as stored, when it reads as one. */
function parseGeom(geom: unknown): WinGeom | undefined {
  if (!geom || typeof geom !== "object") return undefined;
  const { x, y, w, h, max } = geom as Record<string, unknown>;
  return finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0 ? { x, y, w, h, ...(max === true ? { max: true } : {}) } : undefined;
}

/**
 * The pop-ups a tab had (`{ frames, stack, live }`, as stored) and their order back to front: each once, showing a
 * page of a known app (or of none), its place kept only when it reads as one; the page popped out live, the same way
 * (LIVE_ID in the order); the order holds each of them once.
 */
export function parsePopups(raw: string | null, apps: readonly string[]): { list: PopupSaved[]; order: string[]; live: LiveSaved | null } {
  const known = new Set(apps);
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return { list: [], order: [], live: null };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { list: [], order: [], live: null };
  const s = v as Record<string, unknown>;
  const list: PopupSaved[] = [];
  for (const f of Array.isArray(s.frames) ? s.frames : []) {
    if (!f || typeof f !== "object") continue;
    const { id, app, path, geom, hidden } = f as Record<string, unknown>;
    if (typeof id !== "string" || id === LIVE_ID || list.some((o) => o.id === id) || typeof path !== "string" || !path.startsWith("/")) continue;
    if (app !== null && (typeof app !== "string" || !known.has(app))) continue;
    const one: PopupSaved = { id, app, path };
    const g = parseGeom(geom);
    if (g) one.geom = g;
    if (hidden === true) one.hidden = true;
    list.push(one);
  }
  let live: LiveSaved | null = null;
  if (s.live && typeof s.live === "object") {
    const { app, path, geom, hidden } = s.live as Record<string, unknown>;
    if (typeof path === "string" && path.startsWith("/") && path !== "/" && (app === null || (typeof app === "string" && known.has(app)))) {
      live = { path, app };
      const g = parseGeom(geom);
      if (g) live.geom = g;
      if (hidden === true) live.hidden = true;
    }
  }
  const ids = [...(live ? [LIVE_ID] : []), ...list.map((f) => f.id)];
  const order = [...new Set(Array.isArray(s.stack) ? s.stack.filter((x): x is string => typeof x === "string" && ids.includes(x)) : [])];
  return { list, order: [...order, ...ids.filter((id) => !order.includes(id))], live };
}

/* ------------------------------- the widgets ------------------------------- */

/** A spot on the desktop's grid: column c (from the left), row r (from the top). */
export type Cell = { c: number; r: number };
/** A span of the grid: from column c, row r, w columns wide and h rows tall. */
export type CellRect = Cell & { w: number; h: number };

/**
 * The grid the widgets snap to: each cell's size (an 88px column and a 4px gap, a 96px row: the icons' that were, so
 * the spans saved then still hold), and its inset from the edges.
 */
export const GRID = { x: 92, y: 96, pad: 12 } as const;

/** How many columns and rows of the grid fit in a desktop of W × H (inset from every edge; the last column's gap needn't). */
export function gridSize(W: number, H: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((W - GRID.pad * 2 + (GRID.x - 88)) / GRID.x)),
    rows: Math.max(1, Math.floor((H - GRID.pad * 2) / GRID.y)),
  };
}

/** The smallest a widget gets: three cells by three. */
export const WIDGET_MIN = { w: 3, h: 3 } as const;

/** The room a widget leaves inside its span on every side: two side by side are twice that apart. */
const WIDGET_INSET = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Where a widget on a span of cells is on the desktop, in pixels (inset from the span's edges). */
export function cellsRect(a: CellRect): Rect {
  return {
    x: GRID.pad + a.c * GRID.x + WIDGET_INSET,
    y: GRID.pad + a.r * GRID.y + WIDGET_INSET,
    w: a.w * GRID.x - 2 * WIDGET_INSET,
    h: a.h * GRID.y - 2 * WIDGET_INSET,
  };
}

/** Whether two spans share a cell. */
export function overlaps(a: CellRect, b: CellRect): boolean {
  return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
}

/**
 * A widget's spot until it's moved: the terminals at the top right, the projects under them, the disk to their left;
 * the others (off at first, put where the menu was opened) at the top right too, placeWidgets finding them room.
 */
export function defaultWidgetAt(id: WidgetId, cols: number): CellRect {
  const { w } = WIDGET_MIN;
  if (id === "terminals") return { c: cols - w, r: 0, w, h: 3 };
  if (id === "projects") return { c: cols - w, r: 3, w, h: 4 };
  if (id === "disk") return { c: cols - 2 * w, r: 0, w, h: 4 };
  if (id === "memory") return { c: cols - 3 * w, r: 0, w, h: 4 };
  if (id === "processes") return { c: cols - 2 * w, r: 4, w, h: 3 };
  if (id === "docker") return { c: cols - 3 * w, r: 4, w, h: 3 };
  return { c: cols - w, r: 0, w, h: id === "tickets" ? 4 : 3 };
}

/**
 * Where the widgets go on a grid of `cols` × `rows`, in order: each where it wants to be, moved onto the grid when
 * it's off it (and no bigger than the grid); one that would then cover a widget placed before it, the nearest spot
 * on the grid that doesn't, and with none there, the nearest under it (the desktop grows, and scrolls): never one on
 * another.
 */
export function placeWidgets(wants: readonly { id: string; at: CellRect }[], cols: number, rows: number): Record<string, CellRect> {
  const out: Record<string, CellRect> = {};
  const placed: CellRect[] = [];
  for (const { id, at } of wants) {
    const w = Math.min(at.w, cols);
    const h = Math.min(at.h, rows);
    const want = { c: clamp(at.c, 0, cols - w), r: clamp(at.r, 0, rows - h), w, h };
    let best = want;
    if (placed.some((p) => overlaps(p, want))) {
      const nearest = (rowLimit: number) => {
        let found: CellRect | null = null;
        let bestD = Infinity;
        for (let c = 0; c + w <= cols; c++)
          for (let r = 0; r + h <= rowLimit; r++) {
            const spot = { c, r, w, h };
            const d = (c - want.c) ** 2 + (r - want.r) ** 2;
            if (d < bestD && !placed.some((p) => overlaps(p, spot))) {
              bestD = d;
              found = spot;
            }
          }
        return found;
      };
      // (on the grid first; else below everything, where there's always room)
      best = nearest(rows) ?? nearest(Math.max(rows, ...placed.map((p) => p.r + p.h)) + h) ?? want;
    }
    out[id] = best;
    placed.push(best);
  }
  return out;
}

/**
 * Where the widgets that show (not hidden) want to be: their spot (`custom`: put there by hand), or their default; a
 * folded one, its header's row.
 */
export function widgetWants(saved: DeskSaved["widgets"], cols: number): { id: WidgetId; at: CellRect; custom: boolean }[] {
  return WIDGETS.filter((id) => widgetMode(saved, id) !== "hidden").map((id) => {
    const at = saved?.[id]?.at ?? defaultWidgetAt(id, cols);
    return { id, at: widgetMode(saved, id) === "collapsed" ? { ...at, h: 1 } : at, custom: !!saved?.[id]?.at };
  });
}

/**
 * The widgets that show (not hidden), placed on a grid of `cols` × `rows` (placeWidgets). A folded one takes only
 * the row its header is on, so the others can have the rest.
 */
export function deskWidgets(saved: DeskSaved["widgets"], cols: number, rows: number): Partial<Record<WidgetId, CellRect>> {
  return placeWidgets(widgetWants(saved, cols), cols, rows);
}

/**
 * Whether the widgets put by hand fit the desktop's width: from the first one's left edge to the last one's right
 * edge, no more columns than it has; and the ones still at their default (counted from the right edge) have room
 * there. When not (a narrower window), the desktop is stacked. Only the width counts: a widget on another's spot (a
 * new one, at its default) just finds the nearest free one, and a shorter window scrolls.
 */
export function arrangementFits(wants: readonly { at: CellRect; custom?: boolean }[], cols: number): boolean {
  if (wants.some((w) => !w.custom && w.at.c < 0)) return false;
  const mine = wants.filter((w) => w.custom !== false);
  if (!mine.length) return true;
  const left = Math.min(...mine.map((w) => w.at.c));
  const right = Math.max(...mine.map((w) => w.at.c + w.at.w));
  return right - left <= cols;
}

/**
 * The stacked desktop (a window too narrow for the arrangement, a phone's): the widgets one a row, the whole width, in
 * reading order (top to bottom, then left to right, as they were placed), each as tall as it was (in rows). Returns
 * each widget's rect (in pixels, inset as cellsRect's) and the rows they take.
 */
export function stackDesktop(wants: readonly { id: string; at: CellRect }[], W: number): { widgets: Record<string, Rect>; rows: number } {
  const order = [...wants].sort((a, b) => a.at.r - b.at.r || a.at.c - b.at.c);
  const widgets: Record<string, Rect> = {};
  let row = 0;
  for (const w of order) {
    const r = cellsRect({ c: 0, r: row, w: 1, h: w.at.h });
    widgets[w.id] = { ...r, w: Math.max(0, W - 2 * GRID.pad - 2 * (r.x - GRID.pad)) };
    row += w.at.h;
  }
  return { widgets, rows: row };
}

/**
 * A widget dragged (dc, dr) cells (fractions: where the pointer is), snapped to the nearest spot: its column within
 * `cols` (colRange: past the grid's edge when the arrangement moves over to make room), its row on the grid.
 */
export function moveCells(a: CellRect, dc: number, dr: number, cols: { lo: number; hi: number }, rows: number): CellRect {
  return { ...a, c: clamp(Math.round(a.c + dc), cols.lo, Math.max(cols.lo, cols.hi)), r: clamp(Math.round(a.r + dr), 0, Math.max(0, rows - a.h)) };
}

/* -------------------- the arrangement across the desktop -------------------- */

/** The columns the arrangement's spans take, first to last (null: nothing on the desktop). */
function colsOf(spans: readonly CellRect[]): { min: number; max: number } | null {
  if (!spans.length) return null;
  return { min: Math.min(...spans.map((s) => s.c)), max: Math.max(...spans.map((s) => s.c + s.w - 1)) };
}

/**
 * How far right (px) to draw the arrangement (the widgets' spans) in a desktop W wide: centred, or with its last
 * widget against the right edge (as far from it as the first one is from the left, against the left); left, where it is.
 */
export function alignShift(align: DeskAlign, spans: readonly CellRect[], W: number): number {
  const cols = colsOf(spans);
  if (align === "left" || !cols) return 0;
  // (what shows: a widget is inset in its span)
  const left = GRID.pad + cols.min * GRID.x + WIDGET_INSET;
  const right = GRID.pad + (cols.max + 1) * GRID.x - WIDGET_INSET;
  return Math.round(align === "right" ? W - GRID.pad - WIDGET_INSET - right : (W - (right - left)) / 2 - left);
}

/**
 * The columns a span `w` wide can start at when dropped: on screen (the arrangement drawn `shift` px right in a
 * desktop W wide), and the whole, with `others` where they are, still `cols` wide or less. On a centred or
 * right-aligned desktop that can be left of the grid's first column: fitShift then moves the lot back onto it.
 */
export function dropRange(others: readonly CellRect[], w: number, cols: number, shift: number, W: number): { lo: number; hi: number } {
  const span = colsOf(others);
  const lo = Math.ceil(-(GRID.pad + shift) / GRID.x) || 0; // (not -0)
  // (a span's last column shows up to its widget's inset short of its end)
  const hi = Math.floor((W - GRID.pad - shift + WIDGET_INSET) / GRID.x) - w;
  return span
    ? { lo: Math.max(lo, span.max - cols + 1), hi: Math.min(hi, span.min + cols - w) }
    : { lo: Math.max(lo, 0), hi: Math.min(hi, cols - w) };
}

/** Columns to move the whole arrangement by so it's all on a grid `cols` wide again (0 when it is). */
export function fitShift(spans: readonly CellRect[], cols: number): number {
  const span = colsOf(spans);
  if (!span) return 0;
  return span.min < 0 ? -span.min : span.max > cols - 1 ? cols - 1 - span.max : 0;
}

/**
 * A widget resized by dragging `edges` (dc, dr) cells, snapped: the other edges stay, its left and right edges within
 * `cols` (from a column's start to one's end: dropRange's, a cell wide), its rows on the grid, and it's at least
 * WIDGET_MIN (or the room, when that's smaller).
 */
export function resizeCells(a: CellRect, edges: Edges, dc: number, dr: number, cols: { lo: number; hi: number }, rows: number): CellRect {
  const minW = Math.min(WIDGET_MIN.w, cols.hi - cols.lo);
  const minH = Math.min(WIDGET_MIN.h, rows);
  let [l, t, r, b] = [a.c, a.r, a.c + a.w, a.r + a.h];
  if (edges.l) l = clamp(Math.round(l + dc), Math.min(cols.lo, l), r - minW);
  if (edges.r) r = clamp(Math.round(r + dc), l + minW, Math.max(cols.hi, r));
  if (edges.t) t = clamp(Math.round(t + dr), 0, b - minH);
  if (edges.b) b = clamp(Math.round(b + dr), t + minH, rows);
  return { c: l, r: t, w: r - l, h: b - t };
}

/**
 * The widgets as stored; before there were several, the one status widget's folded or hidden carries over to the two
 * it held (terminals, projects).
 */
function parseWidgets(s: Record<string, unknown>): DeskSaved["widgets"] {
  const src = s.widgets && typeof s.widgets === "object" && !Array.isArray(s.widgets) ? (s.widgets as Record<string, unknown>) : null;
  const isInt = (v: unknown): v is number => Number.isInteger(v);
  const out: NonNullable<DeskSaved["widgets"]> = {};
  for (const id of WIDGETS) {
    const one: WidgetSaved = {};
    const v = src?.[id];
    if (v && typeof v === "object") {
      const { at, mode, views } = v as Record<string, unknown>;
      if (mode === "open" || mode === "collapsed" || mode === "hidden") one.mode = mode;
      if (views && typeof views === "object" && !Array.isArray(views)) {
        const ok = Object.entries(views).filter((e): e is [string, string] => /^[a-z]{1,20}$/.test(e[0]) && typeof e[1] === "string" && /^[a-z0-9-]{1,20}$/.test(e[1]));
        if (ok.length) one.views = Object.fromEntries(ok);
      }
      if (at && typeof at === "object") {
        const { c, r, w, h } = at as Record<string, unknown>;
        if (isInt(c) && isInt(r) && isInt(w) && isInt(h) && c >= 0 && r >= 0)
          one.at = { c, r, w: Math.max(w, WIDGET_MIN.w), h: Math.max(h, WIDGET_MIN.h) };
      }
    } else if (!src && (id === "terminals" || id === "projects")) {
      if (s.widget === "collapsed" || s.widget === "hidden") one.mode = s.widget;
      else if (Array.isArray(s.widgetFolded) && s.widgetFolded.includes(id)) one.mode = "collapsed";
    }
    if (one.mode || one.at || one.views) out[id] = one;
  }
  return Object.keys(out).length ? out : undefined;
}
