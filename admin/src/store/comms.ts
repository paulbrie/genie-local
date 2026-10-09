"use client";

import { Subject } from "subjecto";

import type { CommsRole } from "@/lib/claude-comms-parse";

/**
 * Per-browser choices on the Comms page: roles pinned by hand (overriding the
 * guess from who dispatches tasks) and sessions hidden from the diagram, both
 * keyed by session node key, and the projects hidden on Agents 3D.
 * Persisted to localStorage.
 */
export type CommsPrefs = {
  pins: Record<string, CommsRole>;
  hidden: string[];
  /** Agents 3D: project ids (repo top dirs / cwds) hidden; new projects show by default. */
  hiddenProjects: string[];
};

const KEY = "admin.comms.prefs";

// Defaults for a stable first render; `hydrateCommsPrefs()` loads the saved ones.
export const commsPrefs = new Subject<CommsPrefs>(
  { pins: {}, hidden: [], hiddenProjects: [] },
  { name: "commsPrefs" },
);

export function setCommsPrefs(next: CommsPrefs) {
  commsPrefs.next(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage */
  }
}

/** Restore persisted prefs. Call once, client-side, after mount. */
export function hydrateCommsPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    commsPrefs.next({
      pins: s.pins && typeof s.pins === "object" ? s.pins : {},
      hidden: Array.isArray(s.hidden) ? s.hidden.filter((k: unknown) => typeof k === "string") : [],
      hiddenProjects: Array.isArray(s.hiddenProjects)
        ? s.hiddenProjects.filter((k: unknown) => typeof k === "string")
        : [],
    });
  } catch {
    /* ignore malformed state */
  }
}
