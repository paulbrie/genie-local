"use client";

import { Subject } from "subjecto";

import { type Cell, DEFAULT_PINNED, type DeskSaved, parseDesk, type WinGeom } from "@/lib/desktop";

/**
 * The desktop shell's state (components/desktop). The page you're on is the
 * one window; every app you've had in it this tab is "open" (a dot in the dock,
 * reopened at the path you left it on), so switching apps feels like switching
 * windows.
 *
 * `desk`      — the dock's pinned apps, each app window's place and the desktop
 *               icons' arrangement (once moved): localStorage.
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

export const desk = new Subject<DeskSaved>({ pinned: DEFAULT_PINNED, geoms: {} }, { name: "desk" });
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
 * Open app `app` at `path` from the desktop or the dock: the window it already has comes to the front; with none,
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

/** Restore what this browser (and tab) remembers. Call once, client-side, after mount. */
export function hydrateDesk(apps: readonly string[]) {
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
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  desk.next(parseDesk(raw, apps));
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
  if (deskView.getValue().hidden) deskView.next({ hidden: null });
  focusWin(MAIN_WIN);
}

export function minimizeWindow() {
  deskView.next({ hidden: "min" });
}

/**
 * Close `app`'s window (null: a page outside every app): it leaves the dock's
 * open apps. Returns the path of the app to show instead (the one used last),
 * or null when none is left and the bare desktop shows.
 */
export function closeApp(app: string | null): string | null {
  const rest = openApps.getValue().filter((o) => o.app !== app);
  saveOpen(rest);
  const next = rest.reduce<OpenApp | null>((a, o) => (!a || o.at > a.at ? o : a), null);
  if (!next) deskView.next({ hidden: "closed" });
  return next?.path ?? null;
}

export function setPinned(app: string, on: boolean) {
  const cur = desk.getValue();
  const pinned = on ? [...cur.pinned.filter((a) => a !== app), app] : cur.pinned.filter((a) => a !== app);
  save({ ...cur, pinned });
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
