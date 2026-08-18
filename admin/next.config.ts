import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Served behind Nginx at https://ft.cloud.teleporthq.ai/admin (prod) and
  // /admin-dev (the hot-reload dev instance). Both run from THIS working copy;
  // they differ only by env, set per systemd unit:
  //   prod → APP_BASE_PATH=/admin      APP_DIST_DIR=.next-prod  (next start :3001)
  //   dev  → APP_BASE_PATH=/admin-dev  APP_DIST_DIR=.next-dev   (next dev   :3002)
  // Separate distDir keeps `next dev` and `next build/start` from clobbering
  // each other's `.next`. Defaults preserve the original single-instance setup.
  // next/link, router, and static assets are automatically prefixed with basePath.
  basePath: process.env.APP_BASE_PATH ?? "/admin",
  distDir: process.env.APP_DIST_DIR ?? ".next",
  // We run `next dev` behind the nginx proxy on a different host than the dev
  // server's own origin. Next 16's dev server blocks cross-origin requests to
  // /_next/* dev resources with a 403 unless the public host is allowlisted —
  // without this, client chunks fail to load and every client component hangs
  // on "loading…". (Dev-only setting; ignored by `next start`.)
  allowedDevOrigins: ["ft.cloud.teleporthq.ai"],
  experimental: {
    // The app is reached via a proxy on a different host/port than the app's
    // own origin, so allow Server Actions from the public domain (CSRF guard).
    serverActions: {
      allowedOrigins: ["ft.cloud.teleporthq.ai"],
    },
  },
};

export default nextConfig;
