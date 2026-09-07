/**
 * Custom Next.js server for the admin app.
 *
 * Replaces `next start` / `next dev` so we can host a persistent WebSocket in
 * the SAME process/port as Next — used for real-PTY terminals (xterm ⇄ WS ⇄
 * `tmux attach`), giving genie-level typing latency in place of the old
 * HTTP-poll + tmux capture-pane model.
 *
 * Boot (unchanged ports/paths — driven by the systemd units' env):
 *   prod  admin.service      NODE_ENV=production PORT=3001 APP_BASE_PATH=/admin      APP_DIST_DIR=.next-prod
 *   dev   admin-dev.service  (NODE_ENV unset)    PORT=3002 APP_BASE_PATH=/admin-dev  APP_DIST_DIR=.next-dev
 *
 * basePath/distDir/allowedDevOrigins all still come from next.config.ts (read
 * from the same env), so nothing about the built app changes.
 *
 * WebSocket routing: nginx already sets Upgrade/Connection at the server level
 * and proxies /admin* → this port, so `wss://<host><basePath>/pty` arrives here
 * as an HTTP upgrade. We authenticate it with the admin_session cookie (the Next
 * "proxy"/middleware does NOT run for raw upgrades) and hand it to the PTY
 * bridge; every OTHER upgrade (Next's dev HMR socket) is forwarded to Next.
 *
 * This file runs raw (no Next compile) — plain ESM, current Node only.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import next from "next";

import { WebSocketServer } from "ws";

import { handlePtyConnection, verifySessionToken, getCookie } from "./server/pty.mjs";

const require = createRequire(import.meta.url);

const port = parseInt(process.env.PORT || "3001", 10);
const dev = process.env.NODE_ENV !== "production";

// Load .env / .env.local into process.env exactly as `next start`/`next dev` do —
// BEFORE next.config.ts is evaluated (it reads PUBLIC_HOST for allowedDevOrigins)
// and before the PTY cookie auth needs APP_ENC_KEY. That verify runs outside Next,
// so it can't rely on Next having injected the env itself.
require("@next/env").loadEnvConfig(process.cwd(), dev);

const basePath = process.env.APP_BASE_PATH || "/admin";
const PTY_PATH = `${basePath}/pty`;

const app = next({ dev, hostname: "0.0.0.0", port });

// getUpgradeHandler() touches the prepared server, so prepare() must run first.
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => handle(req, res));

// noServer: we own the upgrade routing (Next HMR vs our /pty) below.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === PTY_PATH) {
    // Same-origin browser WS sends the admin_session cookie on the handshake.
    // Auth is enforced HERE because middleware/proxy.ts never sees an upgrade.
    const token = getCookie(req.headers.cookie);
    verifySessionToken(token)
      .then((ok) => {
        if (!ok) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => handlePtyConnection(ws));
      })
      .catch(() => socket.destroy());
    return;
  }

  // Next's own upgrades (webpack-hmr in dev). In prod there are none.
  if (dev) nextUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`> admin server on :${port} (dev=${dev}) basePath=${basePath} pty=${PTY_PATH}`);
});
