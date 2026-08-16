/**
 * Public base path the app is served under (behind Nginx at /admin).
 * Keep in sync with `basePath` in next.config.ts. Used for client-side `fetch`
 * calls, which — unlike next/link — are NOT automatically basePath-prefixed.
 */
export const BASE_PATH = "/admin";
