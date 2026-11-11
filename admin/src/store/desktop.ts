"use client";

import { Subject } from "subjecto";

import { BASE_PATH } from "@/lib/config";
import {
  appOf,
  type Cell,
  type CellRect,
  type DeskAlign,
  type DeskSaved,
  parseDesk,
  SIDEBAR_ICON,
  type WidgetId,
  type WidgetMode,
  type WidgetSaved,
  WIDGETS_OFF,
  type WinGeom,
} from "@/lib/desktop";

/**
 * The desktop shell's state (components/desktop). The page you're on is the
 * one window; every app you've had in it this tab is "open" (a dot by it in the
 * sidebar, reopened at the path you left it on), so switching apps feels like
 * switching windows. Its home ("/") is the desktop itself: no page in a window.
 *
 * `desk`      — each app window's place, the desktop icons' arrangement (once
 *               moved) and the widgets', the sidebar's size: localStorage.
 * `openApps`  — the apps open in this tab, in the order opened: sessionStorage.
 * `deskView`  — the window minimized (kept mounted) or closed (the page unmounted,
 *               the bare desktop showing); not persisted: a reload shows the page.
 * `launchpad` — the all-apps overlay.
 * `frames`    — more windows, each another page of the app in a frame (FrameWindows
 *               in desktop.tsx): sessionStorage, so a reload brings them back.
 * `stack`     — every window's id, back to front ("main" is the page's own window).
 * `deskDrag`  — a window is being dragged or resized: the frames stop taking the
 *               pointer meanwhile (a frame would swallow the moves).
 */
export type OpenApp = { app: string; path: string; at: number };
export type DeskView = { hidden: "min" | "closed" | null };

const KEY = "admin.desktop";
const OPEN_KEY = "admin.desktop.open";

export const desk = new Subject<DeskSaved>({ geoms: {} }, { name: "desk" });
export const openApps = new Subject<OpenApp[]>([], { name: "desk.open" });
export const deskView = new Subject<DeskView>({ hidden: null }, { name: "desk.view" });
export const launchpad = new Subject<boolean>(false, { name: "desk.launchpad" });

/** A window other than the page's own: another page in a frame. */
export type FrameWin = { id: string; app: string | null; path: string; geom?: WinGeom; hidden?: boolean };
export const MAIN_WIN = "main";
const FRAMES_KEY = "admin.desktop.frames";
export const frames = new Subject<FrameWin[]>([], { name: "desk.frames" });
export const stack = new Subject<string[]>([MAIN_WIN], { name: "desk.stack" });
export const deskDrag = new Subject<boolean>(false, { name: "desk.drag" });

function saveFrames(next: FrameWin[], order = stack.getValue()) {
  frames.next(next);
  const ids = new Set([MAIN_WIN, ...next.map((f) => f.id)]);
  stack.next([...order.filter((id) => ids.has(id)), ...[...ids].filter((id) => !order.includes(id))]);
  try {
    sessionStorage.setItem(FRAMES_KEY, JSON.stringify({ frames: next, stack: stack.getValue() }));
  } catch {
    /* ignore */
  }
}

/** Bring window `id` (MAIN_WIN: the page's own) to the front. */
export function focusWin(id: string) {
  const cur = stack.getValue();
  if (cur[cur.length - 1] === id) return;
  stack.next([...cur.filter((x) => x !== id), id]);
  saveFrames(frames.getValue());
}

/** A new window showing `path` (of `app`), in front. Returns its id. */
export function openFrame(path: string, app: string | null): string {
  const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  saveFrames([...frames.getValue(), { id, app, path }], [...stack.getValue(), id]);
  return id;
}

export function updateFrame(id: string, patch: Partial<Omit<FrameWin, "id">>) {
  saveFrames(frames.getValue().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function closeFrame(id: string) {
  saveFrames(frames.getValue().filter((f) => f.id !== id));
}

/** The window in front that isn't minimized (MAIN_WIN, a frame's id, or null). */
export function frontWin(): string | null {
  const hiddenFrames = new Set(frames.getValue().filter((f) => f.hidden).map((f) => f.id));
  const mainHidden = !!deskView.getValue().hidden;
  const order = stack.getValue();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (id === MAIN_WIN ? !mainHidden : !hiddenFrames.has(id)) return id;
  }
  return null;
}

/**
 * Open app `app` at `path` from the desktop or the sidebar: the window it already has comes to the front; with none,
 * the page's own window shows it if that's closed, else it gets a new window. True when it was handled here (the
 * link mustn't navigate the page); false when the page's own window is to show it.
 */
export function openAppWindow(app: string, path: string, mainApp: string | null): boolean {
  if (mainApp === app && deskView.getValue().hidden !== "closed") {
    showWindow();
    focusWin(MAIN_WIN);
    return false;
  }
  const f = frames.getValue().find((x) => x.app === app);
  if (f) {
    if (f.hidden) updateFrame(f.id, { hidden: false });
    focusWin(f.id);
    return true;
  }
  if (deskView.getValue().hidden === "closed") {
    focusWin(MAIN_WIN);
    return false;
  }
  openFrame(path, app);
  return true;
}

let loaded = false;

/**
 * What this browser remembers of the desktop (localStorage), read once: the desktop's own hydrateDesk does it, and so
 * does the Settings page (in the classic interface too, where nothing else does). It follows the changes another
 * document makes (another tab, or Settings in a window's frame), so the desktop around a frame changes with it.
 */
export function loadDesk(apps: readonly string[]) {
  if (loaded) return;
  loaded = true;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  desk.next(parseDesk(raw, apps));
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) desk.next(parseDesk(e.newValue, apps));
  });
}

function save(next: DeskSaved) {
  desk.next(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage */
  }
}

function saveOpen(next: OpenApp[]) {
  openApps.next(next);
  try {
    sessionStorage.setItem(OPEN_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/**
 * Restore what this browser (and tab) remembers. Call once, client-side, after mount. Returns how the page's own
 * window was left on this very page ("min" / "closed", kept so), or null (it shows, as the page you came to).
 */
export function hydrateDesk(apps: readonly string[]): "min" | "closed" | null {
  let kept: "min" | "closed" | null = null;
  try {
    const m = JSON.parse(sessionStorage.getItem(MAIN_KEY) ?? "null") as { hidden?: unknown; path?: unknown } | null;
    if (m && (m.hidden === "min" || m.hidden === "closed") && m.path === here()) {
      kept = m.hidden;
      deskView.next({ hidden: kept });
    } else sessionStorage.removeItem(MAIN_KEY);
  } catch {
    /* unreadable: the window shows */
  }
  try {
    const v = JSON.parse(sessionStorage.getItem(FRAMES_KEY) ?? "null") as { frames?: unknown; stack?: unknown } | null;
    if (v && Array.isArray(v.frames)) {
      const list = v.frames.filter(
        (f): f is FrameWin =>
          typeof f?.id === "string" && typeof f.path === "string" && f.path.startsWith("/") && (f.app === null || (typeof f.app === "string" && apps.includes(f.app))),
      );
      const order = Array.isArray(v.stack) ? v.stack.filter((x): x is string => typeof x === "string") : [];
      saveFrames(list, order.length ? order : [MAIN_WIN, ...list.map((f) => f.id)]);
    }
  } catch {
    /* unreadable: no frames */
  }
  loadDesk(apps);
  const known = new Set(apps);
  try {
    const v = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]");
    if (Array.isArray(v)) {
      const seen = new Set<string>();
      const list = v.filter(
        (o): o is OpenApp =>
          typeof o?.app === "string" &&
          known.has(o.app) &&
          typeof o.path === "string" &&
          o.path.startsWith("/") &&
          typeof o.at === "number" &&
          !seen.has(o.app) &&
          !!seen.add(o.app),
      );
      // keep what the current page already recorded (it mounts before this runs)
      const now = openApps.getValue();
      openApps.next([...list.filter((o) => !now.some((n) => n.app === o.app)), ...now]);
    }
  } catch {
    /* unreadable: start afresh */
  }
  return kept;
}

/** The page shows `path` of `app`: it's open (and the one in front), at that path. */
export function noteApp(app: string, path: string) {
  const cur = openApps.getValue();
  const i = cur.findIndex((o) => o.app === app);
  const entry = { app, path, at: Date.now() };
  saveOpen(i < 0 ? [...cur, entry] : cur.map((o, j) => (j === i ? entry : o)));
}

/** The page's own window: shown (if minimized or closed) and in front. */
export function showWindow() {
  if (deskView.getValue().hidden) {
    deskView.next({ hidden: null });
    rememberMain(null);
  }
  focusWin(MAIN_WIN);
}

export function minimizeWindow() {
  deskView.next({ hidden: "min" });
  rememberMain("min");
}

/** The desktop itself (the sidebar's Desktop, "Show desktop"): every window minimized, the page's own too (unless closed). */
export function showDesktop() {
  if (!deskView.getValue().hidden) minimizeWindow();
  const list = frames.getValue();
  if (list.some((f) => !f.hidden)) saveFrames(list.map((f) => (f.hidden ? f : { ...f, hidden: true })));
}

/**
 * The home ("/") in the desktop: the desktop itself, so the page's own window has nothing to show. It's closed (not
 * remembered: "/" always is), and the next app opened goes in it.
 */
export function atHome() {
  if (deskView.getValue().hidden !== "closed") deskView.next({ hidden: "closed" });
}

// The page's own window minimized or closed, and on which page, for this tab: a reload loads the same address, and
// would show that page's window again (hydrateDesk keeps it as it was instead).
const MAIN_KEY = "admin.desktop.main";
const here = () =>
  (BASE_PATH && window.location.pathname.startsWith(BASE_PATH) ? window.location.pathname.slice(BASE_PATH.length) || "/" : window.location.pathname) +
  window.location.search;
function rememberMain(hidden: "min" | "closed" | null) {
  try {
    if (hidden) sessionStorage.setItem(MAIN_KEY, JSON.stringify({ hidden, path: here() }));
    else sessionStorage.removeItem(MAIN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Close `app`'s window (null: a page outside every app): it leaves the open
 * apps (the sidebar's dots). Returns the path of the app to show instead (the
 * one used last), or null when none is left and the bare desktop shows.
 */
export function closeApp(app: string | null): string | null {
  const rest = openApps.getValue().filter((o) => o.app !== app);
  saveOpen(rest);
  const next = rest.reduce<OpenApp | null>((a, o) => (!a || o.at > a.at ? o : a), null);
  if (!next) {
    deskView.next({ hidden: "closed" });
    rememberMain("closed");
  }
  return next?.path ?? null;
}

/** A widget: open, folded to its header, or off (the Spiridus menu brings it back). */
export function setWidgetMode(id: WidgetId, mode: WidgetMode) {
  // (a widget off at first remembers "open"; one on at first remembers nothing for it)
  patchWidget(id, { mode: mode === "open" && !WIDGETS_OFF.has(id) ? undefined : mode });
}

/** One of a widget's choices of how to show (`key`: the Disk's "chart", the Memory's "split" and "period"), remembered. */
export function setWidgetView(id: WidgetId, key: string, value: string) {
  patchWidget(id, { views: { ...desk.getValue().widgets?.[id]?.views, [key]: value } });
}

/** Where a widget is on the icon grid, and how big (`show`: and on the desktop, if it was off it). */
export function setWidgetAt(id: WidgetId, at: CellRect, show = false) {
  patchWidget(id, show ? { at, mode: WIDGETS_OFF.has(id) ? "open" : undefined } : { at });
}

function patchWidget(id: WidgetId, patch: WidgetSaved) {
  const cur = desk.getValue();
  save({ ...cur, widgets: { ...cur.widgets, [id]: { ...cur.widgets?.[id], ...patch } } });
}

/**
 * Open a page (`path`, e.g. a project's) from the desktop: the window already on it (or under it) comes to the
 * front; with none, a new window, or the page's own one when that's closed. True when handled here; false when the
 * page's own window is to go there (the caller navigates).
 */
export function openPathWindow(path: string, mainPath: string, apps: readonly string[]): boolean {
  const under = (p: string) => p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}?`);
  const closed = deskView.getValue().hidden === "closed";
  if (!closed && under(mainPath)) {
    showWindow();
    return true;
  }
  const f = frames.getValue().find((x) => under(x.path));
  if (f) {
    if (f.hidden) updateFrame(f.id, { hidden: false });
    focusWin(f.id);
    return true;
  }
  if (closed) {
    showWindow();
    return false;
  }
  openFrame(path, appOf(path, apps));
  return true;
}

/** Take an icon (an app's href, or VSCODE_ICON) off the desktop, or put it back (at its old spot, when that's free). */
export function setOnDesktop(id: string, on: boolean) {
  const { removedIcons, ...rest } = desk.getValue();
  const next = on ? (removedIcons ?? []).filter((x) => x !== id) : [...new Set([...(removedIcons ?? []), id])];
  save(next.length ? { ...rest, removedIcons: next } : rest);
}

/** Every icon taken off the desktop back on it. */
export function restoreIcons() {
  const { removedIcons: _old, ...rest } = desk.getValue();
  void _old;
  save(rest);
}

/** The sidebar's icon size in the desktop, in px (kept within SIDEBAR_ICON's range). */
export function setSidebarSize(px: number) {
  const size = Math.round(Math.min(Math.max(px, SIDEBAR_ICON.min), SIDEBAR_ICON.max));
  const { sidebarSize, ...rest } = desk.getValue();
  if (size === (sidebarSize ?? SIDEBAR_ICON.default)) return;
  save(size === SIDEBAR_ICON.default ? rest : { ...rest, sidebarSize: size });
}

/** The icons and widgets, as one arrangement, against the left, centred or against the right. */
export function setAlign(align: DeskAlign) {
  const { align: _old, ...rest } = desk.getValue();
  void _old;
  save(align === "left" ? rest : { ...rest, align });
}

/**
 * The icons' and the widgets' new places at once (a drop, or a widget added, that moves the whole arrangement over);
 * `show`: a widget that goes on the desktop too.
 */
export function setArrangement(icons: Record<string, Cell>, widgets: Partial<Record<WidgetId, CellRect>>, show?: WidgetId) {
  const cur = desk.getValue();
  const next = { ...cur.widgets };
  for (const [id, at] of Object.entries(widgets) as [WidgetId, CellRect][])
    next[id] = { ...next[id], at, ...(id === show ? { mode: WIDGETS_OFF.has(id) ? ("open" as const) : undefined } : {}) };
  save({ ...cur, icons, widgets: next });
}

/** The desktop icons' arrangement, placed by hand (null: back to the default order). */
export function setIcons(icons: Record<string, Cell> | null) {
  const { icons: _old, ...rest } = desk.getValue();
  void _old;
  save(icons ? { ...rest, icons } : rest);
}

export function setGeom(app: string, g: WinGeom) {
  const cur = desk.getValue();
  save({ ...cur, geoms: { ...cur.geoms, [app]: g } });
}
