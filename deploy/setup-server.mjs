#!/usr/bin/env node
//
// setup-server.mjs — first-boot setup UI served at the domain root during install.
//
// deploy/install.sh stands nginx up first (public :3000) proxying the domain ROOT
// to this server (internal :3001). Two phases on the same page:
//
//   1. Confirm the public host. The host the request arrived on (via nginx's
//      X-Forwarded-Host / Host) is auto-detected; the operator confirms it. On
//      confirm we write it to SETUP_HOST_FILE and install.sh continues.
//   2. Live progress. install.sh appends "key|state" lines to SETUP_PROGRESS_FILE
//      as it works (deps → db → migrate → build → services → start → ready). The
//      page polls /setup/status and renders each stage until admin is ready — at
//      which point install.sh flips nginx to /admin and retires this server, and
//      the page (detecting the status endpoint going away) redirects to /admin.
//
// Zero dependencies (node: builtins only). Runs on Node 20+.

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.SETUP_PORT || 3001);
const HOST_FILE = process.env.SETUP_HOST_FILE || "/tmp/genie-setup/host";
const PROGRESS_FILE = process.env.SETUP_PROGRESS_FILE || "/tmp/genie-setup/progress";

// Canonical ordered stages. install.sh emits "key|state" (running|done|failed);
// stages not yet seen render as pending. Labels live here (not in bash).
const STAGES = [
  ["host", "Confirm public host"],
  ["deps", "Install dependencies"],
  ["db", "Configure database"],
  ["migrate", "Run database migrations"],
  ["build", "Build admin (production)"],
  ["services", "Install services & nginx"],
  ["start", "Start admin"],
  ["ready", "Admin ready"],
];

// A conservative hostname check (letters/digits/dots/hyphens, has a dot).
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z0-9-]{1,63}$/;

function detectHost(req) {
  const raw = (req.headers["x-forwarded-host"] || req.headers["host"] || "")
    .toString()
    .split(",")[0]
    .trim();
  return raw.replace(/:\d+$/, "");
}

function confirmedHost() {
  try {
    return fs.readFileSync(HOST_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/** Latest state per stage key from the progress file (last line wins). */
function progressStates() {
  const states = {};
  try {
    for (const line of fs.readFileSync(PROGRESS_FILE, "utf8").split("\n")) {
      const [key, st] = line.split("|");
      if (key && st) states[key.trim()] = st.trim();
    }
  } catch {
    /* file not created yet */
  }
  return states;
}

function statusPayload() {
  const states = progressStates();
  const stages = STAGES.map(([key, label]) => ({
    key,
    label,
    state: states[key] || "pending",
  }));
  return { host: confirmedHost(), stages, ready: states.ready === "done" };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0b0c10; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 560px; background: #15171e; border: 1px solid #262a35; border-radius: 14px; padding: 32px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p.sub { margin: 0 0 24px; color: #9aa4b2; }
  .host { font-size: 20px; font-weight: 600; color: #7dd3fc; word-break: break-all; }
  label { display: block; font-size: 13px; color: #9aa4b2; margin: 20px 0 6px; }
  input { width: 100%; padding: 11px 13px; font-size: 15px; border-radius: 9px; border: 1px solid #333846; background: #0e1016; color: #e6e6e6; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { margin-top: 22px; width: 100%; padding: 12px; font-size: 15px; font-weight: 600; border: 0; border-radius: 9px; background: #3b82f6; color: #fff; cursor: pointer; }
  button:hover { background: #2f6fe0; }
  ul.info { color: #9aa4b2; font-size: 13px; padding-left: 18px; margin: 20px 0 0; }
  ul.info li { margin: 3px 0; }
  .err { background: #3b1d1d; border: 1px solid #5b2626; color: #fca5a5; padding: 10px 12px; border-radius: 9px; margin-bottom: 16px; font-size: 14px; }
  code { color: #cbd5e1; }
  ol.stages { list-style: none; padding: 0; margin: 24px 0 0; }
  ol.stages li { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid #21252f; font-size: 15px; }
  ol.stages li:first-child { border-top: 0; }
  .icon { width: 20px; height: 20px; flex: 0 0 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 13px; font-weight: 700; }
  .pending .icon { color: #5b6472; border: 2px solid #2b303b; }
  .pending { color: #6b7280; }
  .running .icon { color: #0b0c10; background: #3b82f6; animation: pulse 1s ease-in-out infinite; }
  .done .icon { color: #0b0c10; background: #34d399; }
  .failed .icon { color: #fff; background: #ef4444; }
  .failed { color: #fca5a5; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  .banner { margin-top: 22px; padding: 12px 14px; border-radius: 9px; font-weight: 600; text-align: center; }
  .banner.ok { background: #103527; border: 1px solid #1c5b41; color: #6ee7b7; }
  .banner.bad { background: #3b1d1d; border: 1px solid #5b2626; color: #fca5a5; }
`;

function wizardPage({ host, error }) {
  const detected = host && HOST_RE.test(host);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Genie Server Setup</title><style>${STYLE}</style></head>
<body>
  <form class="card" method="POST" action="/setup/confirm">
    <h1>Genie Server Setup</h1>
    <p class="sub">Confirm the public address this server is reached at. Setup then
      runs to completion on this page.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <div>Detected public host:</div>
    <div class="host">${detected ? esc(host) : "could not detect — enter it below"}</div>
    <label for="host">Public hostname (no scheme, no path)</label>
    <input id="host" name="host" value="${detected ? esc(host) : ""}" placeholder="app.example.com" autocomplete="off" spellcheck="false" required />
    <button type="submit">Confirm &amp; start setup →</button>
    <ul class="info">
      <li>Admin dashboard will be served at <code>https://${detected ? esc(host) : "&lt;host&gt;"}/admin</code></li>
      <li>You'll see live progress here until it's ready</li>
    </ul>
  </form>
</body></html>`;
}

function progressPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setting up Genie…</title><style>${STYLE}</style></head>
<body>
  <div class="card">
    <h1>Setting up your server</h1>
    <p class="sub" id="sub">Installing and configuring — leave this page open.</p>
    <ol class="stages" id="stages"></ol>
    <div class="banner ok" id="banner" style="display:none">✓ Admin is ready — redirecting…</div>
  </div>
  <script>
    var ICON = { pending: "", running: "", done: "\\u2713", failed: "\\u2717" };
    var sawStart = false, ready = false;
    function render(s) {
      var ol = document.getElementById("stages");
      ol.innerHTML = s.stages.map(function (st) {
        var mark = ICON[st.state] || "";
        return '<li class="' + st.state + '"><span class="icon">' + mark + "</span>" + st.label + "</li>";
      }).join("");
      if (s.stages.some(function (x) { return x.key === "start" && (x.state === "running" || x.state === "done"); })) sawStart = true;
      if (s.stages.some(function (x) { return x.state === "failed"; })) {
        var b = document.getElementById("banner");
        b.className = "banner bad"; b.style.display = "block";
        b.textContent = "\\u2717 Setup hit an error — check the install logs on the server.";
        document.getElementById("sub").textContent = "Setup paused on a failed step.";
      }
    }
    function goAdmin() { window.location.assign("/admin"); }
    async function poll() {
      try {
        var r = await fetch("/setup/status", { cache: "no-store" });
        if (!r.ok) throw new Error("status " + r.status);
        var s = await r.json();
        render(s);
        if (s.ready && !ready) {
          ready = true;
          document.getElementById("banner").style.display = "block";
          document.getElementById("sub").textContent = "All set.";
        }
      } catch (e) {
        // Status endpoint gone → install flipped nginx to /admin. Hand off.
        if (sawStart || ready) { goAdmin(); return; }
      }
      setTimeout(poll, 900);
    }
    poll();
  </script>
</body></html>`;
}

function successRedirectPage(host) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Continuing…</title>
<meta http-equiv="refresh" content="0; url=/"><style>${STYLE}</style></head>
<body><div class="card"><h1>\\u2713 Host confirmed: ${esc(host)}</h1>
<p class="sub">Starting setup…</p></div></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/setup/status") {
    return send(res, 200, JSON.stringify(statusPayload()), "application/json; charset=utf-8");
  }

  if (req.method === "POST" && url.pathname === "/setup/confirm") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      const host = (new URLSearchParams(body).get("host") || "").trim().toLowerCase();
      if (!HOST_RE.test(host)) {
        return send(res, 400, wizardPage({ host, error: `"${esc(host)}" is not a valid hostname.` }));
      }
      try {
        fs.mkdirSync(HOST_FILE.replace(/\/[^/]*$/, ""), { recursive: true });
        fs.writeFileSync(HOST_FILE, host + "\n", { mode: 0o644 });
      } catch (e) {
        return send(res, 500, wizardPage({ host, error: "Could not persist host: " + e.message }));
      }
      // Do NOT exit — we stay up to stream progress. Send the operator to the
      // progress view (GET / renders progress once the host is confirmed).
      send(res, 200, successRedirectPage(host));
    });
    return;
  }

  // Any other GET → wizard (host not yet confirmed) or progress (confirmed).
  if (req.method === "GET") {
    if (confirmedHost()) return send(res, 200, progressPage());
    return send(res, 200, wizardPage({ host: detectHost(req), error: null }));
  }

  send(res, 405, "Method Not Allowed", "text/plain");
});

server.on("error", (e) => {
  console.error(`setup-server: ${e.code === "EADDRINUSE" ? `port ${PORT} in use` : e.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`setup-server: listening on 127.0.0.1:${PORT} (nginx proxies the domain root here).`);
});
