"use client";

import { Subject } from "subjecto";

import type { RunSummary } from "@/lib/agent-run-types";

/**
 * Global state for the floating agent-run windows — the direct analogue of
 * `@/store/terminals`. Lives outside React (via `subjecto`) and is painted by
 * `<RunDock>` mounted in the root layout, so run windows persist across route
 * changes. Membership is mirrored to localStorage so it also survives a full
 * page reload (the detached runs + their `.progress.json`/`.log` files already
 * do, so a restored window simply re-attaches by runId).
 *
 * `open`      — every run window the user has opened (by runId).
 * `minimized` — the subset collapsed into the dock bar (⊆ `open`).
 */
export type RunDockState = { open: string[]; minimized: string[] };

const KEY = "admin.agentRuns.dock";
const EMPTY: RunDockState = { open: [], minimized: [] };

// Start empty for a stable SSR/first-client render; hydrateRunDock() fills it
// in from localStorage after mount to avoid a hydration mismatch.
export const runDock = new Subject<RunDockState>(EMPTY, { name: "agentRunDock" });

/**
 * Latest run list (history + active), refreshed by <RunDock>'s poll. NON-
 * persisted: it's server-derived and ephemeral. Cards and the minimized chips
 * read it to show live state without each mounting their own poll.
 */
export const activeRuns = new Subject<RunSummary[]>([], { name: "agentRuns" });
export function setActiveRuns(list: RunSummary[]) {
  activeRuns.next(list);
}

/**
 * Optimistically insert/replace one run so a just-started window shows its name
 * and "running" state immediately, before the dock's next list poll catches up.
 */
export function upsertActiveRun(summary: RunSummary) {
  const cur = activeRuns.getValue();
  const rest = cur.filter((r) => r.runId !== summary.runId);
  activeRuns.next([summary, ...rest]);
}

function persist(s: RunDockState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / no storage */
  }
}

function set(next: RunDockState) {
  persist(next);
  runDock.next(next);
}

/** Restore persisted membership. Call once, client-side, after mount. */
export function hydrateRunDock() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    const open = Array.isArray(s.open) ? (s.open as string[]) : [];
    const minimized = Array.isArray(s.minimized)
      ? (s.minimized as string[]).filter((n) => open.includes(n))
      : [];
    runDock.next({ open, minimized });
  } catch {
    /* ignore malformed state */
  }
}

/** Open a run window (or un-minimize one that already exists). */
export function openRun(runId: string) {
  const s = runDock.getValue();
  set({
    open: s.open.includes(runId) ? s.open : [...s.open, runId],
    minimized: s.minimized.filter((n) => n !== runId),
  });
}

/** Close a run window (the run itself keeps going / stays in history). */
export function closeRun(runId: string) {
  const s = runDock.getValue();
  set({
    open: s.open.filter((n) => n !== runId),
    minimized: s.minimized.filter((n) => n !== runId),
  });
}

/** Collapse a run window into the dock bar. */
export function minimizeRun(runId: string) {
  const s = runDock.getValue();
  if (!s.open.includes(runId) || s.minimized.includes(runId)) return;
  set({ open: s.open, minimized: [...s.minimized, runId] });
}

/** Restore a minimized run window back to a floating window. */
export function restoreRun(runId: string) {
  const s = runDock.getValue();
  set({ open: s.open, minimized: s.minimized.filter((n) => n !== runId) });
}

/** Drop windows whose run files have disappeared (e.g. deleted from history). */
export function reconcileRuns(existing: string[]) {
  const s = runDock.getValue();
  const set0 = new Set(existing);
  const open = s.open.filter((n) => set0.has(n));
  if (open.length === s.open.length) return;
  set({ open, minimized: s.minimized.filter((n) => open.includes(n)) });
}
