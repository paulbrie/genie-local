# genie-local

The working tree of a **Genie server** — an Ubuntu box where AI agents build and
supervise projects. This repo is everything under `/opt/project` **except** the
supervised apps themselves (`/projects`, git-ignored) and secrets.

The centerpiece is **`admin/`**, a Next.js dashboard ("Projects Supervisor")
that watches every project, runs their npm scripts, gives you tmux-backed
terminals, a DB explorer, a headless-Chrome live view, agent/pipeline runs, and
system stats.

> This README is written for an **agent setting up a fresh server from scratch**.
> Follow it top to bottom. Commands assume a `sudo`-capable user named `genie`.

---

## 1. Architecture at a glance

```
                      https://ft.cloud.teleporthq.ai   (public)
                                   │
                          nginx  (:3000)               /etc/nginx/sites-available/ft-admin
                          ├── /               → 302 /admin
                          ├── /admin          → 127.0.0.1:3001   (the admin app)
                          └── /projects/<p>/… → 127.0.0.1:<port> (supervised apps, per-project)
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │ admin.service   (systemd)                             │
        │   next dev -p 3001  ·  user genie  ·  Postgres        │
        └───────────────────────────────────────────────────────┘
        genie-stats.service → /run/genie/stats.jsonl  (CPU/mem/disk/process feed)
```

- **Everything runs as the `genie` user.** The admin app is a **`next dev`**
  server (not a production build) managed by systemd.
- Auth is enforced **in-app** (Next 16 "Proxy", `admin/src/proxy.ts`) via a
  signed `admin_session` cookie — nginx does no auth.

### Repo layout

| Path | What it is |
|------|-----------|
| `admin/` | The Next.js 16 dashboard (App Router, Drizzle/Postgres, shadcn/Base UI). Start here: `admin/AGENTS.md`. |
| `agents/` | Markdown-defined **agents** and **pipelines** (see `agents/README.md`). |
| `tools/` | Server-side tools: `playwright-core` (headless Chromium for UI verification) and `local-genie-mcp` (a stdio MCP server for tasks/notes). |
| `projects/` | The supervised apps. **Git-ignored** — each has its own repo. |
| `.mcp.json` | MCP server registry (git-ignored — contains a secret token; recreate it, see §6). |
| `AGENTS.MD` / `CLAUDE.MD` | Top-level server notes for agents. |

---

## 2. Prerequisites

Installed and verified on the reference box:

| Tool | Version | Install |
|------|---------|---------|
| Ubuntu | 24.04 | — |
| Node.js | 20.x (`v20.20.2`) | `nodesource` or nvm |
| npm | 10.x | ships with Node |
| PostgreSQL | 17.x | `apt install postgresql` |
| nginx | 1.24 | `apt install nginx` |
| tmux | 3.4 | `apt install tmux` (powers the Terminals page) |
| git | 2.43 | `apt install git` |
| Claude Code CLI | latest | `claude` on `PATH` — required for agent runs & the terminals/agents features |

```bash
sudo apt update
sudo apt install -y postgresql nginx tmux git curl
# Node 20 (if not present):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```

---

## 3. Get the code

```bash
sudo mkdir -p /opt/project && sudo chown genie:genie /opt/project
git clone https://github.com/paulbrie/genie-local.git /opt/project
cd /opt/project
mkdir -p projects            # supervised apps live here (git-ignored)
```

Install dependencies for each Node package (they're git-ignored, so this is
required):

```bash
cd /opt/project/admin && npm install
cd /opt/project/tools && npm install                 # playwright-core
cd /opt/project/tools/local-genie-mcp && npm install # MCP server
```

Playwright's Chromium binaries live at `~/.cache/ms-playwright/`; install them
once if missing: `cd /opt/project/tools && npx playwright install chromium`.

---

## 4. Database (Postgres)

The admin app owns a database `admin_dashboard` accessed by role `admin_app`.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE admin_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE admin_dashboard OWNER admin_app;
SQL
```

Schema is managed by **Drizzle**; migrations live in `admin/drizzle/`:

```bash
cd /opt/project/admin
npm run db:migrate      # applies drizzle/*.sql   (npm run db:generate to author new ones)
```

---

## 5. Admin app config — `admin/.env.local`

Git-ignored (secrets). Create it with these keys:

```bash
cat > /opt/project/admin/.env.local <<EOF
# Postgres connection for the dashboard's own DB
DATABASE_URL=postgresql://admin_app:CHANGE_ME_STRONG_PASSWORD@localhost:5432/admin_dashboard

# Root dir the dashboard supervises
PROJECTS_ROOT=/opt/project/projects

# AES-256-GCM key: encrypts DB-explorer connection passwords AND signs the
# admin_session cookie (src/lib/session.ts). Generate a fresh one:
APP_ENC_KEY=$(openssl rand -hex 32)

# Login for the dashboard (checked by POST /api/login, constant-time)
ADMIN_USER=admin
ADMIN_PASSWORD=CHANGE_ME
EOF
```

`admin/next.config.ts` is already set for this topology and needs no edits:
- `basePath: "/admin"`
- `allowedDevOrigins: ["ft.cloud.teleporthq.ai"]` — **required**: `next dev`
  behind a proxy on a different host 403s `/_next/*` without it (client hangs on
  "loading…").
- `experimental.serverActions.allowedOrigins` — the public host, or Server
  Actions (notes/tasks/rescan) fail CSRF.

> If you deploy under a different hostname, update those two values to match.

---

## 6. MCP servers — `.mcp.json`

Git-ignored because it holds a bearer token. Recreate at `/opt/project/.mcp.json`:

```json
{
  "mcpServers": {
    "local-genie": {
      "command": "node",
      "args": ["/opt/project/tools/local-genie-mcp/server.mjs"]
    },
    "genie-tracker":  { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/tracker",  "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-security": { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/security", "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-notify":   { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/notify",   "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-storage":  { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/storage",  "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } }
  }
}
```

Replace `<GENIE_VPS_TOKEN>` with the server's Genie API token. `local-genie`
needs no token (it's local stdio). The **agent-browser** MCP (used by the Chrome
live view and the `researcher` agent) is provided by the Claude Code environment.

---

## 7. System services (systemd)

### 7a. Stats publisher — `genie-stats.service`

Feeds the dashboard's CPU/MEM/DISK toolbar and Processes page by appending a
JSON line to `/run/genie/stats.jsonl` every few seconds. It's a globally
installed npm package (`@genie/vps-stats`):

```ini
# /etc/systemd/system/genie-stats.service
[Unit]
Description=Genie VM stats publisher
After=network.target

[Service]
User=genie
ExecStart=/usr/bin/node /usr/lib/node_modules/@genie/vps-stats/dist/daemon.js --interval 5 --output /run/genie/stats.jsonl
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

> The admin reads `/run/genie/stats.jsonl` (override with `STATS_FILE`). Without
> this daemon, stats/processes just show "unavailable" — the app still runs.

### 7b. Admin app — `admin.service`

```ini
# /etc/systemd/system/admin.service
[Unit]
Description=Projects Supervisor (admin Next.js app — DEV behind nginx on :3001)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=genie
Group=genie
WorkingDirectory=/opt/project/admin
Environment=PORT=3001
ExecStart=/usr/bin/node /opt/project/admin/node_modules/next/dist/bin/next dev -p 3001 -H 0.0.0.0
KillMode=process
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**`KillMode=process` is important:** the dashboard launches project dev servers
(and tmux sessions) as detached children; without it a restart of `admin.service`
would kill everything it started.

Enable both:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now genie-stats.service admin.service
journalctl -u admin.service -f     # watch it compile
```

---

## 8. nginx

Public entry on **:3000** (the container/edge exposes this as
`https://ft.cloud.teleporthq.ai`). Minimal site:

```nginx
# /etc/nginx/sites-available/ft-admin
server {
    listen 3000;
    listen [::]:3000;
    server_name ft.cloud.teleporthq.ai _;

    location = / { return 302 /admin; }

    location /admin {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;      # HMR websocket
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Per-project app locations (e.g. /projects/<slug>/… → 127.0.0.1:<port>)
    # are generated/updated by the admin app itself (src/lib/nginx.ts) when you
    # set a project's port in the UI. Leave room for them here.
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/ft-admin /etc/nginx/sites-enabled/ft-admin
sudo nginx -t && sudo systemctl reload nginx
```

- Do **not** add `auth_basic` — auth is in-app (a browser Basic-Auth modal would
  shadow the login page).
- nginx sees the basePath-stripped path; the app's proxy handles `/admin/*`.

---

## 9. Verify

```bash
systemctl is-active admin.service genie-stats.service postgresql nginx
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/     # → 302
```

Then open **`https://<your-host>/admin`** in a real browser (not curl — client
hydration matters) and log in with `ADMIN_USER` / `ADMIN_PASSWORD`. You should
see the dashboard with live CPU/MEM/DISK. Add a folder under
`/opt/project/projects/` and hit **Rescan** to supervise it.

For automated UI checks, use the headless browser in `tools/` (see
`tools/README.md`): import `playwright-core`, `chromium.launch({ headless:true,
args:['--no-sandbox'] })`, and log in via the form or by setting the
`admin_session` cookie. **Reach the app via its public host**, not
`127.0.0.1:3001` — the raw dev origin 403s `/_next/*` (see §5).

---

## 10. Day-2 operations

```bash
# logs
journalctl -u admin.service -f
journalctl -u genie-stats.service -f

# after editing next.config.ts / .env.local (source edits hot-reload, these don't)
sudo systemctl restart admin.service

# db migrations
cd /opt/project/admin && npm run db:generate && npm run db:migrate

# nginx changes
sudo nginx -t && sudo systemctl reload nginx
```

### Gotchas (see `admin/AGENTS.md` for the full list)
- It's a **dev server** — source edits hot-reload; only `next.config.ts` /
  `.env.local` changes need a restart.
- `next dev` behind the proxy needs `allowedDevOrigins` **and**
  `serverActions.allowedOrigins` set to the public host (both already set).
- Server-only modules (`src/lib/signals.ts`, `runner.ts`, `terminals.ts`,
  `chrome.ts`, …) must never be imported from client components.
- Terminals use tmux sessions prefixed `admin-`; the app **only** ever touches
  that prefix, never other tmux sessions on the box.

### Optional
- `code-server.service` (VS Code in the browser) also runs on the reference box
  but isn't required by the dashboard.
