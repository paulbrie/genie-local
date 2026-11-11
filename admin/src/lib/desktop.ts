// Pure, dependency-free: safe for server and client (the layout reads the cookie).
/**
 * The desktop shell (components/desktop): which interface a browser uses, the
 * app a path belongs to, and the main window's geometry inside the workspace
 * (the area under the top bar). Pure, so it is unit-tested; the components do
 * the storage and the DOM.
 */

export type ShellMode = "classic" | "desktop";

/** Remembers the interface per browser, so the server renders the right one at once (no flash of the other). */
export const SHELL_COOKIE = "admin_shell";

export function parseShellMode(v: string | undefined | null): ShellMode {
  return v === "desktop" ? "desktop" : "classic";
}

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

/** The dock's icons, in px: by default, and how small or big dragging its divider makes them. */
export const DOCK_ICON = { min: 32, max: 80, default: 48 } as const;
/** Room kept at the bottom of the workspace for a dock of `icon` px icons (its padding, and the gap under it). */
export function dockSpace(icon: number = DOCK_ICON.default): number {
  return icon + 36;
}
/** Room kept at the bottom of the workspace for the dock, at its default size. */
export const DOCK_SPACE = dockSpace();
/** The smallest a window gets. */
export const MIN_WIN = { w: 380, h: 240 };
/** How much of a window's title bar has to stay on screen. */
const GRIP = 96;
/** The gap around a maximized window. */
const MAX_GAP = 8;
/** Icon columns left uncovered by a new window on a wide screen. */
const ICON_COLUMNS_W = 204;

/** A first window: right of two columns of icons on a wide screen, filling the rest above the dock (`dock`: its room). */
export function defaultGeom(W: number, H: number, dock = DOCK_SPACE): Rect {
  const x = W >= 1280 ? ICON_COLUMNS_W : Math.min(24, Math.round(W * 0.03));
  const y = 12;
  return clampRect({ x, y, w: W - x - 16, h: H - y - dock }, W, H);
}

/** The maximized rect: the whole workspace above the dock (`dock`: its room), a small gap around it. */
export function maxRect(W: number, H: number, dock = DOCK_SPACE): Rect {
  return {
    x: MAX_GAP,
    y: MAX_GAP,
    w: Math.max(0, W - 2 * MAX_GAP),
    h: Math.max(0, H - MAX_GAP - dock),
  };
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

/** What the desktop remembers on this browser (localStorage). */
export type DeskSaved = {
  /** Apps kept in the dock, in order (by href; VS Code by VSCODE_ICON). */
  pinned: string[];
  /** Each app window's place, by app href. */
  geoms: Record<string, WinGeom>;
  /** Where each desktop icon sits, by app href (and VSCODE_ICON), once placed by hand; absent: the default order. */
  icons?: Record<string, Cell>;
  /** The widgets on the wallpaper, by id: where each is and how big (absent: its default spot), folded or hidden (absent: open). */
  widgets?: Partial<Record<WidgetId, WidgetSaved>>;
  /** Icons taken off the desktop (by app href, and VSCODE_ICON). */
  removedIcons?: string[];
  /** The dock's icon size, in px (absent: DOCK_ICON.default). */
  dockSize?: number;
  /** Where the icons and widgets sit across the desktop, as one arrangement: absent is against the left. */
  align?: "center" | "right";
};

export type DeskAlign = "left" | "center" | "right";

/**
 * The desktop's widgets, among the icons: the terminals, the projects, the disk, the memory, the processes and Docker, and the ones that start off
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

export const DEFAULT_PINNED = ["/", "/projects", "/terminals", "/boards", "/files", "/claude", "/tasks"];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored desktop, kept to the apps that still exist; anything unreadable gives the defaults. */
export function parseDesk(raw: string | null, apps: readonly string[]): DeskSaved {
  const known = new Set(apps);
  const out: DeskSaved = { pinned: DEFAULT_PINNED.filter((a) => known.has(a)), geoms: {} };
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const s = v as Record<string, unknown>;
  if (Array.isArray(s.pinned))
    out.pinned = [...new Set(s.pinned.filter((a): a is string => typeof a === "string" && (known.has(a) || a === VSCODE_ICON)))];
  if (s.icons && typeof s.icons === "object" && !Array.isArray(s.icons)) {
    const icons: Record<string, Cell> = {};
    for (const [id, cell] of Object.entries(s.icons as Record<string, unknown>)) {
      if ((!known.has(id) && id !== VSCODE_ICON) || !cell || typeof cell !== "object") continue;
      const { c, r } = cell as Record<string, unknown>;
      if (Number.isInteger(c) && Number.isInteger(r) && (c as number) >= 0 && (r as number) >= 0) icons[id] = { c: c as number, r: r as number };
    }
    if (Object.keys(icons).length) out.icons = icons;
  }
  const widgets = parseWidgets(s);
  if (widgets) out.widgets = widgets;
  if (Array.isArray(s.removedIcons)) {
    const removed = [...new Set(s.removedIcons.filter((id): id is string => typeof id === "string" && (known.has(id) || id === VSCODE_ICON)))];
    if (removed.length) out.removedIcons = removed;
  }
  if (Number.isInteger(s.dockSize) && (s.dockSize as number) >= DOCK_ICON.min && (s.dockSize as number) <= DOCK_ICON.max) out.dockSize = s.dockSize as number;
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

/* ---------------------------- the desktop's icons --------------------------- */

/** A spot on the desktop's icon grid: column c (from the left), row r (from the top). */
export type Cell = { c: number; r: number };

/** VS Code's desktop icon (code-server, outside the app's pages): its key among the icons. */
export const VSCODE_ICON = "vscode";

/** The icon grid: each spot's size (an 88px column and a 4px gap; a 96px row), and its inset from the edges. */
export const ICON_GRID = { x: 92, y: 96, pad: 12 } as const;

/** How many columns and rows of icons fit in a desktop of W × H (the dock's strip kept clear: `dock`, its room). */
export function iconGridSize(W: number, H: number, dock = DOCK_SPACE): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((W - ICON_GRID.pad * 2 + (ICON_GRID.x - 88)) / ICON_GRID.x)),
    rows: Math.max(1, Math.floor((H - ICON_GRID.pad - dock) / ICON_GRID.y)),
  };
}

const cellKey = (c: Cell) => `${c.c},${c.r}`;

/** Every cell the spans cover, by cellKey. */
function covered(spans: readonly CellRect[]): Set<string> {
  const out = new Set<string>();
  for (const s of spans) for (let c = s.c; c < s.c + s.w; c++) for (let r = s.r; r < s.r + s.h; r++) out.add(`${c},${r}`);
  return out;
}

/**
 * Where every icon goes on a grid of `cols` × `rows`, off the cells `blocked` covers (the widgets'): its saved spot
 * when that's on the grid and free; a saved one that no longer fits (a smaller window, a widget over it) the nearest
 * free spot to it; one never placed the first free spot in the default order: down the first column, then the next,
 * `flowRows` deep (the rows the window shows; the grid's own by default), and when those are full, row after row
 * under them (the desktop scrolls), never past the last column.
 */
export function layoutIcons(
  ids: readonly string[],
  saved: Record<string, Cell> | undefined,
  cols: number,
  rows: number,
  blocked: readonly CellRect[] = [],
  flowRows: number = rows,
): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  const taken = covered(blocked);
  const put = (id: string, c: Cell) => {
    out[id] = c;
    taken.add(cellKey(c));
  };
  const fits = (c: Cell) => c.c >= 0 && c.r >= 0 && c.c < cols && c.r < rows;
  // 1. saved spots that are on the grid and not already someone's
  for (const id of ids) {
    const c = saved?.[id];
    if (c && fits(c) && !taken.has(cellKey(c))) put(id, c);
  }
  // 2. saved ones that don't fit any more: the nearest free spot
  for (const id of ids) {
    const want = saved?.[id];
    if (out[id] || !want) continue;
    const target = { c: Math.min(Math.max(want.c, 0), cols - 1), r: Math.min(Math.max(want.r, 0), rows - 1) };
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        if (taken.has(`${c},${r}`)) continue;
        const d = (c - target.c) ** 2 + (r - target.r) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    if (best) put(id, best);
  }
  // 3. the rest (never placed, or no room left): the first free spot, column by column in the rows that show, then
  // row by row under them
  const deep = Math.max(1, Math.min(flowRows, rows));
  const nth = (n: number): Cell => (n < cols * deep ? { c: Math.floor(n / deep), r: n % deep } : { c: (n - cols * deep) % cols, r: deep + Math.floor((n - cols * deep) / cols) });
  let next = 0;
  for (const id of ids) {
    if (out[id]) continue;
    for (;; next++) {
      const c = nth(next);
      if (!taken.has(cellKey(c))) {
        put(id, c);
        break;
      }
    }
  }
  return out;
}

/** `id` dropped on `to`: it goes there, and whatever was there takes its old spot. The whole arrangement, so it holds. */
export function moveIcon(layout: Record<string, Cell>, id: string, to: Cell): Record<string, Cell> {
  const from = layout[id];
  if (!from || (from.c === to.c && from.r === to.r)) return layout;
  const out = { ...layout, [id]: { c: to.c, r: to.r } };
  const other = Object.keys(layout).find((k) => k !== id && layout[k].c === to.c && layout[k].r === to.r);
  if (other) out[other] = { c: from.c, r: from.r };
  return out;
}

/** The icons in alphabetical order (by `labelOf`), in the default flow around the `blocked` cells: "Sort by name". */
export function sortedIcons(ids: readonly string[], labelOf: (id: string) => string, rows: number, blocked: readonly CellRect[] = []): Record<string, Cell> {
  const order = [...ids].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const taken = covered(blocked);
  const out: Record<string, Cell> = {};
  let next = 0;
  for (const id of order) {
    while (taken.has(`${Math.floor(next / rows)},${next % rows}`)) next++;
    out[id] = { c: Math.floor(next / rows), r: next % rows };
    next++;
  }
  return out;
}

/* ------------------------------- the widgets ------------------------------- */

/** A span of the icon grid: from column c, row r, w columns wide and h rows tall. */
export type CellRect = Cell & { w: number; h: number };

/** The smallest a widget gets: three icons by three. */
export const WIDGET_MIN = { w: 3, h: 3 } as const;

/** The room a widget leaves inside its span on every side: two side by side are twice that apart. */
const WIDGET_INSET = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Where a widget on a span of cells is on the desktop, in pixels (inset from the span's edges). */
export function cellsRect(a: CellRect): Rect {
  return {
    x: ICON_GRID.pad + a.c * ICON_GRID.x + WIDGET_INSET,
    y: ICON_GRID.pad + a.r * ICON_GRID.y + WIDGET_INSET,
    w: a.w * ICON_GRID.x - 2 * WIDGET_INSET,
    h: a.h * ICON_GRID.y - 2 * WIDGET_INSET,
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
 * the row its header is on, so the icons can have the rest.
 */
export function deskWidgets(saved: DeskSaved["widgets"], cols: number, rows: number): Partial<Record<WidgetId, CellRect>> {
  return placeWidgets(widgetWants(saved, cols), cols, rows);
}

/**
 * Whether the widgets put by hand fit the desktop's width: from the first one's left edge to the last one's right
 * edge, no more columns than it has; and the ones still at their default (counted from the right edge) have room
 * there. When not (a narrower window), the desktop is stacked. Only the width counts: a widget on another's spot (a
 * new one, at its default) just finds the nearest free one, and a shorter window scrolls; the icons always find room.
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
 * The stacked desktop (a window too narrow for the arrangement): the widgets one a row, the whole width, in reading
 * order (top to bottom, then left to right, as they were placed), each as tall as it was (in rows); then the icons,
 * a row after another, under them. Returns each widget's rect (in pixels, inset as cellsRect's), each icon's cell,
 * and the rows it all takes.
 */
export function stackDesktop(
  wants: readonly { id: string; at: CellRect }[],
  iconIds: readonly string[],
  W: number,
): { widgets: Record<string, Rect>; icons: Record<string, Cell>; rows: number } {
  const order = [...wants].sort((a, b) => a.at.r - b.at.r || a.at.c - b.at.c);
  const widgets: Record<string, Rect> = {};
  let row = 0;
  for (const w of order) {
    const r = cellsRect({ c: 0, r: row, w: 1, h: w.at.h });
    widgets[w.id] = { ...r, w: Math.max(0, W - 2 * ICON_GRID.pad - 2 * (r.x - ICON_GRID.pad)) };
    row += w.at.h;
  }
  const perRow = Math.max(1, Math.floor((W - ICON_GRID.pad * 2 + (ICON_GRID.x - 88)) / ICON_GRID.x));
  const icons = Object.fromEntries(iconIds.map((id, i) => [id, { c: i % perRow, r: row + Math.floor(i / perRow) }]));
  return { widgets, icons, rows: row + Math.ceil(iconIds.length / perRow) };
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
 * How far right (px) to draw the arrangement (the icons and widgets, `spans`) in a desktop W wide: centred, or with
 * its last column against the right edge (as far as the left one is from the left); left, where it is.
 */
export function alignShift(align: DeskAlign, spans: readonly CellRect[], W: number): number {
  const cols = colsOf(spans);
  if (align === "left" || !cols) return 0;
  const left = ICON_GRID.pad + cols.min * ICON_GRID.x;
  // (an icon is 84 wide in its 92px column, a widget inset as much: what shows ends 8px short of the last column)
  const right = ICON_GRID.pad + (cols.max + 1) * ICON_GRID.x - (ICON_GRID.x - 84);
  return Math.round(align === "right" ? W - ICON_GRID.pad - right : (W - (right - left)) / 2 - left);
}

/**
 * The columns a span `w` wide can start at when dropped: on screen (the arrangement drawn `shift` px right in a
 * desktop W wide), and the whole, with `others` where they are, still `cols` wide or less. On a centred or
 * right-aligned desktop that can be left of the grid's first column: fitShift then moves the lot back onto it.
 */
export function dropRange(others: readonly CellRect[], w: number, cols: number, shift: number, W: number): { lo: number; hi: number } {
  const span = colsOf(others);
  const lo = Math.ceil(-(ICON_GRID.pad + shift) / ICON_GRID.x) || 0; // (not -0)
  const hi = Math.floor((W - ICON_GRID.pad - shift + (ICON_GRID.x - 84)) / ICON_GRID.x) - w;
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
