"use client";

import { Subject } from "subjecto";

import { PARTICIPANT_COLORS, type Author } from "@/lib/boards/core.mjs";

/**
 * Who you are on boards. The admin has a single shared login, so each browser
 * picks a display name and cursor colour once; the id is random and stays.
 */
const KEY = "admin.boards.identity";

function load(): Author | null {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.id === "string" && typeof v.name === "string" && v.name.trim()) return v;
  } catch {
    /* fall through */
  }
  return null;
}

/** undefined until read from localStorage, then null (not chosen yet) or you. */
export const identity = new Subject<Author | null | undefined>(undefined, { name: "boards.identity" });

/** Read the stored identity (call once on mount, client only). */
export function loadIdentity() {
  identity.next(load());
}

export function saveIdentity(name: string, color: string) {
  const prev = identity.getValue() ?? load();
  const id =
    prev?.id ??
    `u${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  const user: Author = { id, name: name.trim().slice(0, 40), color };
  localStorage.setItem(KEY, JSON.stringify(user));
  identity.next(user);
  return user;
}

export function randomColor() {
  return PARTICIPANT_COLORS[Math.floor(Math.random() * PARTICIPANT_COLORS.length)];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
