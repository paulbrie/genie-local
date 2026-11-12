"use client";

import { Subject } from "subjecto";

import {
  type CellRect,
  type DeskAlign,
  type DeskSaved,
  frontmost,
  NAV_ALWAYS,
  parseDesk,
  parsePopups,
  pathUnder,
  type PopupSaved,
  SIDEBAR_ICON,
  type WidgetId,
  type WidgetMode,
  type WidgetSaved,
  WIDGETS_OFF,
  type WinGeom,
} from "@/lib/desktop";

/**
 * The desktop shell's state (components/desktop). A page shows inline, beside the sidebar, as in classic; one popped
 * out is a window of its own over that area, as is one opened in a new window: each a page of the app in a frame
 * (FrameWindows in desktop.tsx). Home ("/") is the wallpaper with its widgets.
 *
 * `desk`      — where each app's pop-up opens, the widgets', the sidebar's size and the items it leaves out (classic's
 *               too): localStorage.
 * `frames`    — the pop-ups (the apps popped out: the sidebar's dots): sessionStorage, so a reload brings them back.
 * `stack`     — the pop-ups' ids, back to front.
 * `deskDrag`  — a window or a widget is being dragged or resized: the frames stop taking the pointer meanwhile (a
 *               frame would swallow the moves).
 */
const KEY = "admin.desktop";

export const desk = new Subject<DeskSaved>({ geoms: {} }, { name: "desk" });

/** A pop-up window: a page of the app in a frame. */
export type FrameWin = PopupSaved;
const FRAMES_KEY = "admin.desktop.frames";
export const frames = new Subject<FrameWin[]>([], { name: "desk.frames" });
export const stack = new Subject<string[]>([], { name: "desk.stack" });
export const deskDrag = new Subject<boolean>(false, { name: "desk.drag" });

function saveFrames(next: FrameWin[], order = stack.getValue()) {
  frames.next(next);
  const ids = next.map((f) => f.id);
  stack.next([...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))]);
  try {
    sessionStorage.setItem(FRAMES_KEY, JSON.stringify({ frames: next, stack: stack.getValue() }));
  } catch {
    /* ignore */
  }
}

/** Bring pop-up `id` to the front. */
export function focusWin(id: string) {
  const cur = stack.getValue();
  if (cur[cur.length - 1] === id) return;
  stack.next([...cur.filter((x) => x !== id), id]);
  saveFrames(frames.getValue());
}

/** A new pop-up showing `path` (of `app`), in front: a page popped out, or opened in a new window. Returns its id. */
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

/** Of the pop-ups that `pick` picks, the one nearest the front comes up (if minimized) and to the front; false: none. */
function raise(pick: (f: FrameWin) => boolean): boolean {
  const list = frames.getValue();
  const id = frontmost(stack.getValue(), list.filter(pick).map((f) => f.id));
  if (!id) return false;
  if (list.find((f) => f.id === id)?.hidden) updateFrame(id, { hidden: false });
  focusWin(id);
  return true;
}

/**
 * App `app` from the sidebar (or a widget, Settings…): if it's popped out, its window comes to the front. True when it
 * is; false: the page shows inline (the caller's link navigates).
 */
export function raiseApp(app: string): boolean {
  return raise((f) => f.app === app);
}

/** A page (`path`, e.g. a project's) from the desktop: the pop-up on it, or under it, comes to the front; false: none. */
export function raisePath(path: string): boolean {
  return raise((f) => pathUnder(f.path, path));
}

/** Every pop-up minimized (the Spiridus menu's "Show Home"). */
export function minimizeAll() {
  const list = frames.getValue();
  if (list.some((f) => !f.hidden)) saveFrames(list.map((f) => (f.hidden ? f : { ...f, hidden: true })));
}

let loaded = false;

/**
 * What this browser remembers of the desktop (localStorage), read once: the desktop's own hydrateDesk does it, and so
 * do the sidebar and the Settings page (in the classic interface too). It follows the changes another document makes
 * (another tab, or Settings in a pop-up's frame), so the desktop around a frame changes with it.
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

let hydrated = false;

/** Restore what this browser and tab remember: the pop-ups (sessionStorage), and the desk. Once, client-side, after mount. */
export function hydrateDesk(apps: readonly string[]) {
  if (hydrated) return;
  hydrated = true;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(FRAMES_KEY);
  } catch {
    /* ignore */
  }
  const { list, order } = parsePopups(raw, apps);
  if (list.length) saveFrames(list, order);
  loadDesk(apps);
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

/** Where a widget is on the grid, and how big (`show`: and on the desktop, if it was off it). */
export function setWidgetAt(id: WidgetId, at: CellRect, show = false) {
  patchWidget(id, show ? { at, mode: WIDGETS_OFF.has(id) ? "open" : undefined } : { at });
}

function patchWidget(id: WidgetId, patch: WidgetSaved) {
  const cur = desk.getValue();
  save({ ...cur, widgets: { ...cur.widgets, [id]: { ...cur.widgets?.[id], ...patch } } });
}

/**
 * Show a sidebar item (an app's href, or VSCODE_NAV) or leave it out, in both interfaces (Settings → General, or its
 * right-click menu); the home and Settings always show. Its window, if it has one, stays open.
 */
export function setNavShown(id: string, on: boolean) {
  if (NAV_ALWAYS.includes(id)) return;
  const { hiddenNav, ...rest } = desk.getValue();
  const next = on ? (hiddenNav ?? []).filter((x) => x !== id) : [...new Set([...(hiddenNav ?? []), id])];
  save(next.length ? { ...rest, hiddenNav: next } : rest);
}

/** Every sidebar item back in it. */
export function showAllNav() {
  const { hiddenNav: _old, ...rest } = desk.getValue();
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

/** The widgets, as one arrangement, against the left, centred or against the right. */
export function setAlign(align: DeskAlign) {
  const { align: _old, ...rest } = desk.getValue();
  void _old;
  save(align === "left" ? rest : { ...rest, align });
}

/** The widgets' new places at once (a drop that moves the whole arrangement over, to keep it on the grid). */
export function setArrangement(widgets: Partial<Record<WidgetId, CellRect>>) {
  const cur = desk.getValue();
  const next = { ...cur.widgets };
  for (const [id, at] of Object.entries(widgets) as [WidgetId, CellRect][]) next[id] = { ...next[id], at };
  save({ ...cur, widgets: next });
}

export function setGeom(app: string, g: WinGeom) {
  const cur = desk.getValue();
  save({ ...cur, geoms: { ...cur.geoms, [app]: g } });
}
