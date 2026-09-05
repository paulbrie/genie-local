#!/usr/bin/env node
//
// setup-server.mjs — the first-boot setup wizard for a fresh Genie box.
//
// deploy/install.sh launches this BEFORE it configures nginx, on the exposed
// port 3000. The operator opens the box's public URL at /setup; the page shows
// the hostname the request arrived on (from X-Forwarded-Host / Host — i.e. the
// real public domain the box is reachable at) and asks them to confirm it.
//
// On confirm we write the chosen host to SETUP_HOST_FILE and exit. install.sh
// reads that file and bakes the host into the systemd units (APP_PUBLIC_HOSTS,
// which next.config.ts reads) and the nginx server_name — so nothing is
// hardcoded and every install adapts to wherever it is deployed.
//
// Zero dependencies (node: builtins only). Runs on Node 20+.

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.SETUP_PORT || 3000);
const HOST_FILE = process.env.SETUP_HOST_FILE || "/tmp/genie-setup-host";

// A conservative hostname check (letters/digits/dots/hyphens, has a dot).
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z0-9-]{1,63}$/;

/** The public host the request arrived on, stripped of any :port. */
function detectHost(req) {
  const raw =
    (req.headers["x-forwarded-host"] || req.headers["host"] || "")
      .toString()
      .split(",")[0]
      .trim();
  return raw.replace(/:\d+$/, "");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function page({ host, error }) {
  const detected = host && HOST_RE.test(host);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Genie Server Setup</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0b0c10; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 560px; background: #15171e; border: 1px solid #262a35; border-radius: 14px; padding: 32px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p.sub { margin: 0 0 24px; color: #9aa4b2; }
  .host { font-size: 20px; font-weight: 600; color: #7dd3fc; word-break: break-all; }
  label { display: block; font-size: 13px; color: #9aa4b2; margin: 20px 0 6px; }
  input { width: 100%; padding: 11px 13px; font-size: 15px; border-radius: 9px; border: 1px solid #333846;
          background: #0e1016; color: #e6e6e6; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { margin-top: 22px; width: 100%; padding: 12px; font-size: 15px; font-weight: 600; border: 0; border-radius: 9px;
           background: #3b82f6; color: #fff; cursor: pointer; }
  button:hover { background: #2f6fe0; }
  ul { color: #9aa4b2; font-size: 13px; padding-left: 18px; margin: 20px 0 0; }
  li { margin: 3px 0; }
  .err { background: #3b1d1d; border: 1px solid #5b2626; color: #fca5a5; padding: 10px 12px; border-radius: 9px; margin-bottom: 16px; font-size: 14px; }
  code { color: #cbd5e1; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/setup/confirm">
    <h1>Genie Server Setup</h1>
    <p class="sub">Confirm the public address this server is reached at. It will be
      wired into the app config (<code>next.config.ts</code>) and nginx.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <div>Detected public host:</div>
    <div class="host">${detected ? esc(host) : "could not detect — enter it below"}</div>
    <label for="host">Public hostname (no scheme, no path)</label>
    <input id="host" name="host" value="${detected ? esc(host) : ""}"
           placeholder="app.example.com" autocomplete="off" spellcheck="false" required />
    <button type="submit">Confirm &amp; continue setup →</button>
    <ul>
      <li>Admin dashboard will be served at <code>https://${detected ? esc(host) : "&lt;host&gt;"}/admin</code></li>
      <li>Hot-reload dev instance at <code>/admin-dev</code> (started on demand)</li>
      <li>PostgreSQL, nginx and systemd services are installed after you confirm</li>
    </ul>
  </form>
</body>
</html>`;
}

function successPage(host) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Setup continuing…</title>
<style>body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0c10;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}.card{max-width:520px;background:#15171e;border:1px solid #262a35;border-radius:14px;padding:32px;text-align:center}.host{color:#7dd3fc;font-weight:600}h1{margin:0 0 8px}</style>
</head><body><div class="card">
<h1>✓ Host confirmed</h1>
<p>Setup is continuing on the server. When it finishes, the dashboard will be at</p>
<p class="host">https://${esc(host)}/admin</p>
<p style="color:#9aa4b2;font-size:13px">You can close this tab. This page stops responding once setup takes over port 3000.</p>
</div></body></html>`;
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/setup/confirm") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy(); // guard against abuse
    });
    req.on("end", () => {
      const host = (new URLSearchParams(body).get("host") || "").trim().toLowerCase();
      if (!HOST_RE.test(host)) {
        return send(res, 400, page({ host, error: `"${esc(host)}" is not a valid hostname.` }));
      }
      try {
        fs.writeFileSync(HOST_FILE, host + "\n", { mode: 0o644 });
      } catch (e) {
        return send(res, 500, page({ host, error: "Could not persist host: " + e.message }));
      }
      send(res, 200, successPage(host));
      // Give the response time to flush, then exit so install.sh proceeds and
      // frees :3000 for nginx.
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 400);
    });
    return;
  }

  // Any GET → show the wizard (so hitting / or /setup both work).
  if (req.method === "GET") {
    return send(res, 200, page({ host: detectHost(req), error: null }));
  }

  send(res, 405, "Method Not Allowed", "text/plain");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `setup-server: port ${PORT} is already in use. Free it (e.g. \`systemctl stop nginx\`) ` +
        `or set PUBLIC_HOST to skip the wizard.`,
    );
  } else {
    console.error("setup-server error:", e.message);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(
    `setup-server: listening on :${PORT} — open your box's public URL at /setup ` +
      `(host will be written to ${HOST_FILE}).`,
  );
});
