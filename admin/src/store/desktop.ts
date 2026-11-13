"use client";

import { Subject } from "subjecto";

import {
  type CellRect,
  type DeskAlign,
  type DeskSaved,
  frontmost,
  LIVE_ID,
  type LiveSaved,
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
 * The desktop shell's state (components/desktop). A page shows inline, beside the sidebar. Popped out,
 * it's a window of its own over that area, live: the route's own page restyled, its state kept (`liveWin`); a page
 * opened in a new window, or one popped out live that something else then took the route from, is a page of the app
 * in a frame (FrameWindows in desktop.tsx). Home ("/") is the wallpaper with its widgets.
 *
 * `desk`      — where each app's pop-up opens, the widgets', the sidebar's size and the items it leaves out:
 *               localStorage.
 * `frames`    — the frame pop-ups, and `liveWin` the live one (the apps popped out: the sidebar's dots), with `stack`:
 *               sessionStorage, so a reload brings them back.
 * `stack`     — the pop-ups' ids, back to front (LIVE_ID: the live one).
 * `liveFocus` — whether the last press or key was in the live window: where the route goes then is the page's own
 *               way (it follows), else something else's (it goes on in a frame); liveFate.
 * `deskDrag`  — a window or a widget is being dragged or resized: the frames stop taking the pointer meanwhile (a
 *               frame would swallow the moves).
 */
const KEY = "admin.desktop";

export const desk = new Subject<DeskSaved>({ geoms: {} }, { name: "desk" });

/** A pop-up window: a page of the app in a frame (`attaching`: put back inline, it goes once its page is there). */
export type FrameWin = PopupSaved & { attaching?: boolean };
export type LiveWin = LiveSaved;
const FRAMES_KEY = "admin.desktop.frames";
export const frames = new Subject<FrameWin[]>([], { name: "desk.frames" });
export const liveWin = new Subject<LiveWin | null>(null, { name: "desk.live" });
export const stack = new Subject<string[]>([], { name: "desk.stack" });
export const liveFocus = new Subject<boolean>(false, { name: "desk.liveFocus" });
export const deskDrag = new Subject<boolean>(false, { name: "desk.drag" });

/** The pop-ups as they are now: the frames, the live one, their order (each once), kept for the tab. */
function commit(list: FrameWin[], live: LiveWin | null, order = stack.getValue()) {
  frames.next(list);
  liveWin.next(live);
  const ids = [...(live ? [LIVE_ID] : []), ...list.map((f) => f.id)];
  stack.next([...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))]);
  try {
    const stored = live && !live.closing ? { path: live.path, app: live.app, geom: live.geom, hidden: live.hidden } : null;
    sessionStorage.setItem(FRAMES_KEY, JSON.stringify({ frames: list, stack: stack.getValue(), live: stored }));
  } catch {
    /* ignore */
  }
}

const saveFrames = (list: FrameWin[], order?: string[]) => commit(list, liveWin.getValue(), order);

/** Bring pop-up `id` (LIVE_ID: the live one) to the front. */
export function focusWin(id: string) {
  const cur = stack.getValue();
  if (cur[cur.length - 1] === id) return;
  commit(frames.getValue(), liveWin.getValue(), [...cur.filter((x) => x !== id), id]);
}

const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new frame pop-up showing `path` (of `app`), in front: a page opened in a new window. Returns its id. */
export function openFrame(path: string, app: string | null): string {
  const id = newId();
  saveFrames([...frames.getValue(), { id, app, path }], [...stack.getValue(), id]);
  return id;
}

export function updateFrame(id: string, patch: Partial<Omit<FrameWin, "id">>) {
  saveFrames(frames.getValue().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function closeFrame(id: string) {
  saveFrames(frames.getValue().filter((f) => f.id !== id));
}

/** The page inline (`path`, with its query, of `app`) popped out live, in front: nothing reloads, the URL stays. */
export function detachLive(path: string, app: string | null) {
  commit(frames.getValue(), { path, app }, [...stack.getValue().filter((x) => x !== LIVE_ID), LIVE_ID]);
}

export function updateLive(patch: Partial<LiveWin>) {
  const live = liveWin.getValue();
  if (live) commit(frames.getValue(), { ...live, ...patch });
}

/** The live window put back inline: the page restyles in place, nothing reloads. */
export function attachLive() {
  commit(frames.getValue(), null);
}

/** The live window closed: out of sight while the route goes Home (the caller's), then gone (Workspace, liveFate). */
export function closeLive() {
  updateLive({ hidden: true, closing: true });
}

/** The live window gone on in a frame at its path, at its place and its place in the order: something else took the route. */
export function liveToFrame() {
  const live = liveWin.getValue();
  if (!live) return;
  const id = newId();
  commit([...frames.getValue(), { id, app: live.app, path: live.path, geom: live.geom, hidden: live.hidden }], null, stack.getValue().map((x) => (x === LIVE_ID ? id : x)));
}

/** The frames put back inline, gone now that the route has moved (their page, or where it led, is inline). */
export function closeAttached() {
  const list = frames.getValue();
  if (list.some((f) => f.attaching)) saveFrames(list.filter((f) => !f.attaching));
}

/** Of the pop-ups that `pick` picks, the one nearest the front comes up (if minimized) and to the front; false: none. */
function raise(pick: (w: { app: string | null; path: string }) => boolean): boolean {
  const list = frames.getValue();
  const live = liveWin.getValue();
  const ids = [...(live && !live.closing && pick(live) ? [LIVE_ID] : []), ...list.filter(pick).map((f) => f.id)];
  const id = frontmost(stack.getValue(), ids);
  if (!id) return false;
  if (id === LIVE_ID) {
    if (live?.hidden) updateLive({ hidden: false });
  } else if (list.find((f) => f.id === id)?.hidden) updateFrame(id, { hidden: false });
  focusWin(id);
  return true;
}

/**
 * App `app` from the sidebar (or a widget, Settings…): if it's popped out (live, or in a frame), its window comes to
 * the front. True when it is; false: the page shows inline (the caller's link navigates).
 */
export function raiseApp(app: string): boolean {
  return raise((w) => w.app === app);
}

/** A page (`path`, e.g. a project's) from the desktop: the pop-up on it, or under it, comes to the front; false: none. */
export function raisePath(path: string): boolean {
  return raise((w) => pathUnder(w.path, path));
}

/**
 * Show page `href` from the desktop (⌘K, a widget's row, Settings): its pop-up to the front if it has one; Home as it
 * is while a page floats over it, live; else inline (`push`).
 */
export function openPage(href: string, push: (href: string) => void) {
  if (raisePath(href)) return;
  if (href === "/" && liveWin.getValue()) return;
  push(href);
}

/** Every pop-up minimized, the live one too (the Spiridus menu's "Show Home"). */
export function minimizeAll() {
  const list = frames.getValue();
  const live = liveWin.getValue();
  if (list.some((f) => !f.hidden) || (live && !live.hidden))
    commit(list.map((f) => (f.hidden ? f : { ...f, hidden: true })), live && { ...live, hidden: true });
}

let loaded = false;

/**
 * What this browser remembers of the desktop (localStorage), read once: the desktop's own hydrateDesk does it, and so
 * do the sidebar and the Settings page. It follows the changes another document makes
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

/**
 * Restore what this browser and tab remember: the pop-ups (sessionStorage), and the desk. Once, client-side, after
 * mount. The page popped out live floats again if the route is its page (`here`); another's, it goes on in a frame.
 */
export function hydrateDesk(apps: readonly string[], here: string) {
  if (hydrated) return;
  hydrated = true;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(FRAMES_KEY);
  } catch {
    /* ignore */
  }
  const { list, order, live } = parsePopups(raw, apps);
  if (list.length || live) commit(list, live, order);
  if (live && live.path.split("?")[0] !== here) liveToFrame();
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
 * Show a sidebar item (an app's href, or VSCODE_NAV) or leave it out (Settings → General, or its right-click menu);
 * Home and Settings always show. Its window, if it has one, stays open.
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
