"use client";

import { Subject } from "subjecto";

/**
 * Global state for the floating terminal windows. Lives outside React (via
 * `subjecto`) and is mounted by `<TerminalDock>` in the root layout, so the
 * windows persist across route changes — navigating between pages no longer
 * unmounts them. Membership is mirrored to localStorage so it also survives a
 * full page reload (the tmux sessions themselves already do).
 *
 * `open`      — every window the user has opened.
 * `minimized` — the subset collapsed into the bottom dock bar (⊆ `open`).
 */
export type DockState = { open: string[]; minimized: string[] };

/**
 * Per-terminal live status. Kept in a separate, NON-persisted subject (status is
 * ephemeral) so any surface — a floating window, the bottom bar chip, the
 * management list — can render the same dot, including while a window is
 * collapsed (a minimized window stays mounted and keeps reporting).
 */
export type TermStatus = "idle" | "busy" | "claude-working" | "claude-waiting";
export const termStatus = new Subject<Record<string, TermStatus>>(
  {},
  { name: "terminalStatus" },
);
export function setTerminalStatus(name: string, status: TermStatus) {
  const cur = termStatus.getValue();
  if (cur[name] === status) return;
  termStatus.next({ ...cur, [name]: status });
}

/**
 * Authoritative live terminal list (name + status), refreshed by <TerminalDock>'s
 * poll of /api/terminals. Unlike `termStatus` (which only accumulates and never
 * prunes), this reflects exactly the sessions that currently exist — so surfaces
 * like the sidebar can list "currently working" terminals without showing dead
 * ones. NON-persisted: it's server-derived and ephemeral.
 */
export type LiveTerminal = { name: string; status: TermStatus };
export const liveTerminals = new Subject<LiveTerminal[]>([], {
  name: "liveTerminals",
});
export function setLiveTerminals(list: LiveTerminal[]) {
  liveTerminals.next(list);
}

const KEY = "admin.terminals.dock";
const EMPTY: DockState = { open: [], minimized: [] };

// Start empty for a stable SSR/first-client render; `hydrateDock()` fills it in
// from localStorage after mount to avoid a hydration mismatch.
export const dock = new Subject<DockState>(EMPTY, { name: "terminalDock" });

function persist(s: DockState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / no storage */
  }
}

function set(next: DockState) {
  persist(next);
  dock.next(next);
}

/** Restore persisted membership. Call once, client-side, after mount. */
export function hydrateDock() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    const open = Array.isArray(s.open) ? (s.open as string[]) : [];
    const minimized = Array.isArray(s.minimized)
      ? (s.minimized as string[]).filter((n) => open.includes(n))
      : [];
    dock.next({ open, minimized });
  } catch {
    /* ignore malformed state */
  }
}

/** Open a window (or un-minimize + focus one that already exists). Moves the
 *  name to the end of `open` so it's the frontmost — on mobile the last visible
 *  terminal is the one shown full-screen. */
export function openTerminal(name: string) {
  const s = dock.getValue();
  const open = s.open.includes(name)
    ? [...s.open.filter((n) => n !== name), name]
    : [...s.open, name];
  set({ open, minimized: s.minimized.filter((n) => n !== name) });
}

/** Close a window entirely (the tmux session keeps running). */
export function closeTerminal(name: string) {
  const s = dock.getValue();
  set({
    open: s.open.filter((n) => n !== name),
    minimized: s.minimized.filter((n) => n !== name),
  });
}

/** Collapse a window into the bottom dock bar. */
export function minimizeTerminal(name: string) {
  const s = dock.getValue();
  if (!s.open.includes(name) || s.minimized.includes(name)) return;
  set({ open: s.open, minimized: [...s.minimized, name] });
}

/** Restore a minimized window back to a floating window. */
export function restoreTerminal(name: string) {
  const s = dock.getValue();
  set({ open: s.open, minimized: s.minimized.filter((n) => n !== name) });
}

/** Carry a window's dock membership over when its session is renamed. */
export function renameTerminal(oldName: string, next: string) {
  const s = dock.getValue();
  set({
    open: s.open.map((n) => (n === oldName ? next : n)),
    minimized: s.minimized.map((n) => (n === oldName ? next : n)),
  });
}

/** Drop windows whose tmux session has disappeared. */
export function reconcileTerminals(existing: string[]) {
  const s = dock.getValue();
  const open = s.open.filter((n) => existing.includes(n));
  if (open.length === s.open.length) return;
  set({ open, minimized: s.minimized.filter((n) => open.includes(n)) });
}
