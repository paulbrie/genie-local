/**
 * Public base path the app is served under (behind Nginx at /admin for prod,
 * /admin-dev for the hot-reload dev instance). Used for client-side `fetch`
 * calls, which — unlike next/link — are NOT automatically basePath-prefixed.
 *
 * Mirrors `basePath` in next.config.ts. Both derive from the same per-instance
 * env so a single working copy can serve both mounts. NEXT_PUBLIC_* is inlined
 * into the client bundle at build (prod) / compile (dev) time, so the deploy
 * build and the dev service each set NEXT_PUBLIC_BASE_PATH to match APP_BASE_PATH.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "/admin";
