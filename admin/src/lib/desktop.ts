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

/** Room kept at the bottom of the workspace for the dock. */
export const DOCK_SPACE = 84;
/** The smallest a window gets. */
export const MIN_WIN = { w: 380, h: 240 };
/** How much of a window's title bar has to stay on screen. */
const GRIP = 96;
/** The gap around a maximized window. */
const MAX_GAP = 8;
/** Icon columns left uncovered by a new window on a wide screen. */
const ICON_COLUMNS_W = 204;

/** A first window: right of two columns of icons on a wide screen, filling the rest above the dock. */
export function defaultGeom(W: number, H: number): Rect {
  const x = W >= 1280 ? ICON_COLUMNS_W : Math.min(24, Math.round(W * 0.03));
  const y = 12;
  return clampRect({ x, y, w: W - x - 16, h: H - y - DOCK_SPACE }, W, H);
}

/** The maximized rect: the whole workspace above the dock, a small gap around it. */
export function maxRect(W: number, H: number): Rect {
  return {
    x: MAX_GAP,
    y: MAX_GAP,
    w: Math.max(0, W - 2 * MAX_GAP),
    h: Math.max(0, H - MAX_GAP - DOCK_SPACE),
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

/** A rect resized from `start` by dragging `edges` (dx, dy), kept at least MIN_WIN and inside the workspace's top/left. */
export function resizeRect(start: Rect, edges: Edges, dx: number, dy: number, W: number, H: number): Rect {
  let { x, y, w, h } = start;
  if (edges.r) w = Math.min(Math.max(MIN_WIN.w, start.w + dx), W - start.x);
  if (edges.b) h = Math.min(Math.max(MIN_WIN.h, start.h + dy), H - start.y);
  if (edges.l) {
    const nx = Math.min(Math.max(0, start.x + dx), start.x + start.w - MIN_WIN.w);
    w = start.w + (start.x - nx);
    x = nx;
  }
  if (edges.t) {
    const ny = Math.min(Math.max(0, start.y + dy), start.y + start.h - MIN_WIN.h);
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
  /** Apps kept in the dock, in order. */
  pinned: string[];
  /** Each app window's place, by app href. */
  geoms: Record<string, WinGeom>;
  /** Where each desktop icon sits, by app href (and VSCODE_ICON), once placed by hand; absent: the default order. */
  icons?: Record<string, Cell>;
  /** The status widget (terminals and projects): absent is "open". */
  widget?: WidgetMode;
  /** Which side of the desktop it's on: absent is the right. */
  widgetSide?: "left";
};

export type WidgetMode = "open" | "collapsed" | "hidden";

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
    out.pinned = [...new Set(s.pinned.filter((a): a is string => typeof a === "string" && known.has(a)))];
  if (s.icons && typeof s.icons === "object" && !Array.isArray(s.icons)) {
    const icons: Record<string, Cell> = {};
    for (const [id, cell] of Object.entries(s.icons as Record<string, unknown>)) {
      if ((!known.has(id) && id !== VSCODE_ICON) || !cell || typeof cell !== "object") continue;
      const { c, r } = cell as Record<string, unknown>;
      if (Number.isInteger(c) && Number.isInteger(r) && (c as number) >= 0 && (r as number) >= 0) icons[id] = { c: c as number, r: r as number };
    }
    if (Object.keys(icons).length) out.icons = icons;
  }
  if (s.widget === "collapsed" || s.widget === "hidden") out.widget = s.widget;
  if (s.widgetSide === "left") out.widgetSide = "left";
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

/** How many columns and rows of icons fit in a desktop of W × H (the dock's strip kept clear). */
export function iconGridSize(W: number, H: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((W - ICON_GRID.pad * 2 + (ICON_GRID.x - 88)) / ICON_GRID.x)),
    rows: Math.max(1, Math.floor((H - ICON_GRID.pad - DOCK_SPACE) / ICON_GRID.y)),
  };
}

const cellKey = (c: Cell) => `${c.c},${c.r}`;

/**
 * Where every icon goes on a grid of `cols` × `rows`: its saved spot when that's on the grid and free; a saved one
 * that no longer fits (a smaller window) the nearest free spot to it; one never placed the first free spot in the
 * default order (down the first column, then the next). Past a full grid, more columns.
 */
export function layoutIcons(ids: readonly string[], saved: Record<string, Cell> | undefined, cols: number, rows: number): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  const taken = new Set<string>();
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
  // 3. the rest (never placed, or no room left): the first free spot, column by column
  let next = 0;
  for (const id of ids) {
    if (out[id]) continue;
    for (;; next++) {
      const c = { c: Math.floor(next / rows), r: next % rows };
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

/** The icons in alphabetical order (by `labelOf`), in the default flow: "Sort by name". */
export function sortedIcons(ids: readonly string[], labelOf: (id: string) => string, rows: number): Record<string, Cell> {
  const order = [...ids].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  return Object.fromEntries(order.map((id, i) => [id, { c: Math.floor(i / rows), r: i % rows }]));
}
