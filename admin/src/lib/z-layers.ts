/**
 * The app's stacking bands, lowest to highest. Page content (sticky headers,
 * drawers, dialogs, menus: shadcn's z-50 and below) stays under 100, so the
 * floating terminals always sit above whatever a page draws, and the small
 * global controls stay reachable above the terminals.
 */

/**
 * The file explorer's file windows (Files, a project's Files tab) count up from
 * here as they're raised: above the page and its dialogs, under the terminals.
 */
export const Z_FILE_WINDOWS = 1_000;

/** The explorer's own dialogs (rename, move, delete, …): above its file windows. */
export const Z_FILE_DIALOGS = 9_000;

/** Floating terminal windows count up from here as they're raised. */
export const Z_TERMINAL_WINDOWS = 10_000;

/**
 * App-wide controls above every terminal: the run dock, the minimized
 * terminals bar, the Jarvis console. (Toasts are higher still: sonner's own.)
 */
export const Z_GLOBAL_CONTROLS = 1_000_000;

/** Full-screen terminal on phones, and Jarvis's speaking orb: on top of all of it. */
export const Z_GLOBAL_OVERLAY = 1_000_010;
