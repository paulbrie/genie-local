"use client";

import { Subject } from "subjecto";

/**
 * The boards last opened on this browser, most recent first, shown under Boards in the sidebar. Persisted to
 * localStorage; starts empty for a stable first render and is filled in by hydrateRecentBoards() after mount.
 */
export type RecentBoard = { id: number; title: string };

const KEY = "admin.boards.recent";
export const RECENT_BOARDS_MAX = 10;

export const recentBoards = new Subject<RecentBoard[]>([], { name: "boards.recent" });

function set(next: RecentBoard[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage */
  }
  recentBoards.next(next);
}

/** Restore the list. Call once, client-side, after mount. */
export function hydrateRecentBoards() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(v))
      recentBoards.next(
        v.filter((b) => Number.isInteger(b?.id) && b.id > 0 && typeof b.title === "string").slice(0, RECENT_BOARDS_MAX),
      );
  } catch {
    /* unreadable: start afresh */
  }
}

/** A board opened: to the top of the list. */
export function noteBoardOpened(id: number, title: string) {
  set([{ id, title }, ...recentBoards.getValue().filter((b) => b.id !== id)].slice(0, RECENT_BOARDS_MAX));
}

/** Current names from the board list, and the boards gone from it (archived or deleted) dropped. */
export function syncRecentBoards(list: RecentBoard[]) {
  const titles = new Map(list.map((b) => [b.id, b.title]));
  const cur = recentBoards.getValue();
  const next = cur.filter((b) => titles.has(b.id)).map((b) => ({ id: b.id, title: titles.get(b.id)! }));
  if (next.length !== cur.length || next.some((b, i) => b.title !== cur[i].title)) set(next);
}
