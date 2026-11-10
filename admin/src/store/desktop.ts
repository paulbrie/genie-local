"use client";

import { Subject } from "subjecto";

import { DEFAULT_PINNED, type DeskSaved, parseDesk, type WinGeom } from "@/lib/desktop";

/**
 * The desktop shell's state (components/desktop). The page you're on is the
 * one window; every app you've had in it this tab is "open" (a dot in the dock,
 * reopened at the path you left it on), so switching apps feels like switching
 * windows.
 *
 * `desk`      — the dock's pinned apps and each app window's place: localStorage.
 * `openApps`  — the apps open in this tab, in the order opened: sessionStorage.
 * `deskView`  — the window minimized (kept mounted) or closed (the page unmounted,
 *               the bare desktop showing); not persisted: a reload shows the page.
 * `launchpad` — the all-apps overlay.
 */
export type OpenApp = { app: string; path: string; at: number };
export type DeskView = { hidden: "min" | "closed" | null };

const KEY = "admin.desktop";
const OPEN_KEY = "admin.desktop.open";

export const desk = new Subject<DeskSaved>({ pinned: DEFAULT_PINNED, geoms: {} }, { name: "desk" });
export const openApps = new Subject<OpenApp[]>([], { name: "desk.open" });
export const deskView = new Subject<DeskView>({ hidden: null }, { name: "desk.view" });
export const launchpad = new Subject<boolean>(false, { name: "desk.launchpad" });

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

export function showWindow() {
  if (deskView.getValue().hidden) deskView.next({ hidden: null });
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

export function setGeom(app: string, g: WinGeom) {
  const cur = desk.getValue();
  save({ ...cur, geoms: { ...cur.geoms, [app]: g } });
}
