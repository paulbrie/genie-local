"use client";

import { Subject } from "subjecto";

/**
 * The boards last opened on this browser, most recent first, shown under Boards in the sidebar. Persisted to
 * localStorage; starts empty for a stable first render and is filled in by hydrateRecentBoards() after mount.
 */
export type RecentBoard = { id: number; title: string };

const KEY = "admin.boards.recent";
export const RECENT_BOARDS_MAX = 10;

/**
 * What the sidebar shows: the boards opened here, then, in the places left (so it isn't empty on a browser that
 * hasn't opened any yet), the boards edited last. Only the opened ones are remembered.
 */
export const recentBoards = new Subject<RecentBoard[]>([], { name: "boards.recent" });

let opened: RecentBoard[] | null = null;
/** the board list, most recently edited first (as /api/boards sends it); null until fetched */
let known: RecentBoard[] | null = null;

function show() {
  const titles = known && new Map(known.map((b) => [b.id, b.title]));
  // (a board archived or deleted since drops out; a renamed one shows its new name)
  const mine = titles ? load().filter((b) => titles.has(b.id)).map((b) => ({ id: b.id, title: titles.get(b.id)! })) : load();
  const ids = new Set(mine.map((b) => b.id));
  recentBoards.next([...mine, ...(known ?? []).filter((b) => !ids.has(b.id))].slice(0, RECENT_BOARDS_MAX));
}

function remember(next: RecentBoard[]) {
  opened = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage */
  }
  show();
}

/** The opened boards, read from localStorage the first time (a board page records itself before the sidebar mounts). */
function load(): RecentBoard[] {
  if (opened) return opened;
  opened = [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(v))
      opened = v.filter((b) => Number.isInteger(b?.id) && b.id > 0 && typeof b.title === "string").slice(0, RECENT_BOARDS_MAX);
  } catch {
    /* unreadable: start afresh */
  }
  return opened;
}

/** Restore the list. Call once, client-side, after mount. */
export function hydrateRecentBoards() {
  load();
  show();
}

/** A board opened: to the top of the list. */
export function noteBoardOpened(id: number, title: string) {
  remember([{ id, title }, ...load().filter((b) => b.id !== id)].slice(0, RECENT_BOARDS_MAX));
}

/** The board list as fetched: current names, the boards gone from it, and the ones to fill the list with. */
export function syncRecentBoards(list: RecentBoard[]) {
  known = list.map((b) => ({ id: b.id, title: b.title }));
  show();
}
