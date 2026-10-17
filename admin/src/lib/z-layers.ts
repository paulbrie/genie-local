/**
 * The app's stacking bands, lowest to highest. Page content (sticky headers,
 * drawers, dialogs, menus: shadcn's z-50 and below) stays under 100, so the
 * floating terminals always sit above whatever a page draws, and the small
 * global controls stay reachable above the terminals.
 */

/** Floating terminal windows count up from here as they're raised. */
export const Z_TERMINAL_WINDOWS = 10_000;

/**
 * App-wide controls above every terminal: the run dock, the minimized
 * terminals bar, the Jarvis console. (Toasts are higher still: sonner's own.)
 */
export const Z_GLOBAL_CONTROLS = 1_000_000;

/** Full-screen terminal on phones, and Jarvis's speaking orb: on top of all of it. */
export const Z_GLOBAL_OVERLAY = 1_000_010;
