# genie-local

**genie-local** is the working tree of a *Genie server*: a single Ubuntu box where
AI coding agents (Claude Code) build, run and supervise many projects side by side.
The repo holds everything under `/opt/project` **except** the supervised apps
themselves (`/opt/project/projects/`, git-ignored, each with its own repo) and
secrets. Its centerpiece is **`admin/`**, a Next.js 16 dashboard called the
**Projects Supervisor**. It discovers every project on the box, shows its git state
and runs any of its `package.json` scripts. It also gives you browser terminals
backed by persistent tmux sessions (with Claude-aware status, token meters and a
voice narrator), plus managers for system processes, systemd services, Docker
containers and stray headless-Chrome instances. On top of that come a
Postgres/MySQL explorer, a Mermaid diagram editor, a Railway log browser, a
viewer for `~/.claude` sessions and memories, and a runner for Markdown-defined
agents and pipelines. All of it sits behind one login and one nginx entry point.

> The original version of this README was written for an agent setting up a
> fresh server. That is still the main use case, and every command below assumes a
> `sudo`-capable Unix user named **`genie`** and the install root **`/opt/project`**.

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Requirements](#requirements)
4. [Installation](#installation)
   - [Option A: the Genie "genie-local" recipe](#option-a-the-genie-genie-local-recipe)
   - [Option B: the automated installer (`deploy/install.sh`)](#option-b-the-automated-installer-deployinstallsh)
   - [Option C: manual install, step by step](#option-c-manual-install-step-by-step)
5. [Configuration](#configuration)
6. [Database](#database)
7. [Running, building, deploying and upgrading](#running-building-deploying-and-upgrading)
8. [HTTP API overview](#http-api-overview)
9. [The local-genie MCP server](#the-local-genie-mcp-server)
10. [Agents and pipelines](#agents-and-pipelines)
11. [Server tooling (`tools/`)](#server-tooling-tools)
12. [Security](#security)
13. [Known gaps and doc drift](#known-gaps-and-doc-drift)
14. [Troubleshooting / FAQ](#troubleshooting--faq)
15. [Contributing](#contributing)
16. [License](#license)

---

## Features

Every page lives under the app's base path (`/admin` in production, `/admin-dev`
for the hot-reload instance) and requires a login.

### Projects, apps, notes and tasks (Dashboard, `/projects/<slug>`)
- **Auto-discovery.** Every top-level directory under `PROJECTS_ROOT`
  (default `/opt/project/projects`) is a **project**. Each immediate subdirectory
  that has a `.git` or a `package.json` is an **app** inside it. If the project
  directory is itself an app, it gets a single root app.
- **Live signals per app.** You see git branch, dirty state, ahead/behind,
  last commit, directory mtime, size, README presence and `package.json`
  scripts. A **Rescan** stores a `status_snapshots` row for each app.
- **Run any npm script.** Every `package.json` script gets Run / Stop / Restart
  plus a status dot. Each script runs as its own detached process group, with
  output appended to `/tmp/projects/<project>-<app>-<script>.log` and a deep link
  to the Logs page. Starting `build` never touches a running `dev`.
- **Running state on cards.** Dashboard cards poll `/api/run-status`. An app
  shows as running when its `dev`/`start` process is alive or something is
  listening on its port. Cards also show resident memory.
- **Per-app port, routed by nginx.** Set an app's port in the UI and the
  dashboard regenerates `admin/nginx/projects.conf` with a
  `location /projects/<project>[/<app>]` block and reloads nginx through a
  confined sudo helper. The app's own `basePath` must match the mount path.
- **Notes and tasks per project.** Add, edit, delete and drag to reorder, with a
  done toggle and a description on tasks. The same data is available to Claude
  through the [local-genie MCP server](#the-local-genie-mcp-server).
- **Archive / restore.** "Delete" archives a project in the DB. Files on disk are
  never touched.

### Terminals (`/terminals` and the app-wide terminal dock)
- Browser terminals backed by **tmux sessions prefixed `admin-`**. The app only
  ever lists, captures, signals or kills sessions with that prefix.
- **Real PTY over WebSocket.** xterm.js connects to `<basePath>/pty`, which
  `admin/server.mjs` serves in the same process as Next. It runs
  `tmux attach-session -t admin-<name>` through `node-pty`, so sessions outlive
  the browser and the server.
- **Claude-aware status.** A session can be idle, busy, `claude-working`,
  `claude-idle` or `claude-input` (blocked on your answer). The dock also shows a
  cumulative **in/out token meter** for Claude sessions and per-session memory.
- **Clipboard image paste.** A pasted image is uploaded to
  `/tmp/admin-terminal-pastes/` (20 MB max) and its path is typed into the pane,
  so a `claude` session can read it.
- Create, rename and kill sessions. Movable, resizable dock windows persist
  across page navigation.

### Voice: alerts, "Jarvis" narrator and Q&A (text-to-speech)
- **Voice alerts** when a terminal finishes or needs input.
- **Jarvis mode.** An ambient narrator watches every live terminal. Changed
  terminals are batched into a single `POST /api/narrate`, which asks the
  server's own `claude` CLI (`claude-haiku-4-5`, all tools disabled) for a short
  spoken summary. A Web Locks leader election makes sure only one browser tab
  narrates.
- **Hold-to-talk Q&A.** Browser speech recognition captures your question and
  sends it to `POST /api/ask`. The server snapshots all terminals, Claude
  answers, and the answer is spoken aloud. An animated orb reacts to the audio.
- **TTS engines.** The default is **Kokoro** (`POST /api/tts` proxies to a local
  Kokoro-FastAPI container at `KOKORO_URL`, default `http://127.0.0.1:8880`,
  OpenAI-compatible `/v1/audio/speech`). The alternative is the browser's Web
  Speech voice. If Kokoro is unreachable, the route returns 503 and the client
  falls back to the browser voice. **The Kokoro container is not provisioned by
  this repo.** See [Known gaps](#known-gaps-and-doc-drift).

### VS Code
- The sidebar has a **VS Code** link to `/vscode/` (outside the base path), and
  `GET /api/authcheck` exists as an nginx `auth_request` probe, so code-server
  can sit behind the same session cookie. `deploy/install.sh` can install
  code-server and a `code-server.service` (`INSTALL_CODE_SERVER=1`, the default).
  However, **no `/vscode` nginx location is shipped in this repo**, so you have
  to add the reverse-proxy block yourself.

### Processes (`/processes`) and system stats
- A process table built from the `genie-stats` daemon feed
  (`/run/genie/stats.jsonl`). You can signal a process or its whole subtree
  (SIGTERM / SIGKILL / SIGINT / SIGHUP). PID 1, the admin server and its parent
  are protected.
- A **CPU / MEM / DISK toolbar** in the top bar, plus a **1d / 7d / 30d history
  chart**. The chart is backed by a per-minute cron sampler that writes to a
  persistent file (`/opt/project/.stats-history/history.jsonl`, pruned after
  30 days).

### Services (`/services`)
- Lists systemd `*.service` units, with a curated set by default (admin,
  admin-dev, nginx, docker, containerd, code-server, cron, ssh, postgresql, and
  units prefixed `genie`, `ft-`, `vps-` and a few project prefixes) and a
  "show all" toggle.
- start / stop / restart / enable / disable through `sudo -n systemctl …`, plus
  journald logs. `stop`/`disable` are blocked for `admin.service`, ssh, logind
  and dbus. These actions need broader sudo than the scoped sudoers file grants;
  see [Security](#security).
- **Deploy panel.** Shows prod/dev state, the last deploy result and buttons
  that drive `admin-ctl` (build + restart prod, start/stop the dev instance).

### Docker (`/docker`)
- Containers (start / stop / restart / remove, logs) and images (remove), through
  the `docker` CLI. The `genie` user must be able to reach the Docker daemon.

### Chrome (`/chrome`)
- Groups running Chrome/Chromium processes into **instances** by
  `--user-data-dir` (read from `/proc`), with process count, memory and age.
  You can kill one instance, all of them, or only the agent-browser ones.
- **Live view** of agent-browser instances (`/tmp/agent-browser-chrome-*`): open
  tabs via the DevTools `/json/list` endpoint and periodic JPEG screenshots. The
  screenshots attach over CDP with the globally installed Playwright at
  `/usr/lib/node_modules/@playwright/test`, which you have to install
  separately.

### Logs (`/logs`)
- Lists and tails log files (`.log .out .err .jsonl .txt`) under `LOGS_ROOT`
  (default `/tmp`, so it includes `/tmp/projects/*.log` and the deploy log). It
  also shows agent run logs under a virtual `run-logs/…` prefix. Tails are
  256 KB by default, capped at 4 MB.

### DB Explorer (`/db`)
- Saved **PostgreSQL** and **MySQL** connections. Passwords are encrypted at rest
  with AES-256-GCM using `APP_ENC_KEY`.
- Browse databases → tables → columns, page through rows (max 500 per page),
  insert / update / delete rows, run arbitrary SQL (Postgres
  `statement_timeout` 20 s) and save named queries per connection and database.

### Diagrams (`/diagrams`)
- Mermaid diagrams stored as text in Postgres, with a CodeMirror editor, live
  preview, server-side validation, rename / duplicate, archive (soft delete),
  restore and purge.
- An **agent-facing REST API** (`/api/diagrams`, `/api/diagrams/validate`). It
  accepts either the session cookie or an `x-api-key` header that matches
  `DIAGRAMS_API_KEY`.

### Claude (`/claude`)
- A read-only explorer over the `~/.claude` directory of the user that runs the
  admin service (`CLAUDE_HOME`). It has three tabs. **Sessions** lists the
  per-project JSONL transcripts with a rendered transcript view. **Logs** lists
  raw `*.log`/`*.jsonl` files with a tail view. **Memories** shows the
  per-project `memory/*.md` files.
- There is no chat UI in this app. Interactive Claude use happens in the
  terminals.

### Railway (`/railway`)
- A read-only browser for the Railway GraphQL API: projects → services →
  deployments → logs (with Railway's native filter syntax). Captured logs can be
  handed to the `railway-discovery` agent. This needs `RAILWAY_API_TOKEN` (an
  account-scoped token).

### Agents (`/agents`)
- Create, edit (visual form), duplicate, delete and **run** the Markdown agents
  and pipelines in `agents/`. Runs are headless `claude -p` processes with live
  step tracking, log tailing, token/cost/duration metrics, artifacts, re-run,
  a queue/concurrency limit, timeouts, retention and an optional completion
  webhook. See [Agents and pipelines](#agents-and-pipelines).

### UI
- shadcn/ui on Base UI, Tailwind 4, light/dark theme, collapsible sidebar,
  mobile layout, `subjecto` stores for UI state.

---

## Architecture

### Components and how they talk

```mermaid
flowchart TB
  Browser["Browser<br/>https://admin.example.com/admin"]
  Edge["TLS edge (optional, external)<br/>terminates HTTPS"]
  Nginx["nginx :3000<br/>site 'ft-admin'"]
  Prod["admin.service :3002<br/>server.mjs (Next prod, .next-prod)<br/>+ /admin/pty WebSocket"]
  Dev["admin-dev.service :3003<br/>server.mjs (Next dev, .next-dev)<br/>on demand"]
  Apps["Supervised apps<br/>127.0.0.1:&lt;port&gt; per app"]
  PG[("PostgreSQL :5432<br/>db admin_dashboard")]
  Stats["genie-stats.service<br/>→ /run/genie/stats.jsonl"]
  Cron["cron (every minute)<br/>scripts/stats-history.mjs<br/>→ .stats-history/history.jsonl"]
  Tmux["tmux sessions admin-*"]
  Claude["claude CLI<br/>(agent runs, narrate/ask)"]
  Kokoro["Kokoro-FastAPI :8880<br/>(optional, Docker)"]
  Host["systemd · docker · /proc · git"]
  Ctl["/usr/local/bin/admin-ctl<br/>/usr/local/bin/ft-nginx-reload<br/>(root, scoped sudoers)"]
  MCP["tools/local-genie-mcp<br/>(stdio MCP, spawned by Claude Code)"]
  Railway["Railway GraphQL API"]

  Browser --> Edge --> Nginx
  Nginx -- "/admin" --> Prod
  Nginx -- "/admin-dev" --> Dev
  Nginx -- "/projects/&lt;slug&gt;" --> Apps
  Prod --> PG
  Prod --> Stats
  Prod --> Cron
  Prod --> Tmux
  Prod --> Claude
  Prod --> Kokoro
  Prod --> Host
  Prod -- "sudo -n" --> Ctl
  Prod --> Railway
  MCP --> PG
```

A more detailed internal module map is in
[`admin/docs/architecture.mmd`](admin/docs/architecture.mmd). Some ports in it
are outdated; see
[Known gaps](#known-gaps-and-doc-drift).

**Request flow.** The public HTTPS URL reaches nginx on **:3000**. nginx itself
speaks plain HTTP, sets `X-Forwarded-Proto https` and assumes TLS is terminated
upstream. nginx routes by longest prefix:

| Path | Upstream | Notes |
|------|----------|-------|
| `= /` | `302 /admin` | |
| `/admin` | `127.0.0.1:3002` | production instance |
| `/admin-dev` | `127.0.0.1:3003` | hot-reload dev instance, started on demand |
| `/projects/<project>[/<app>]` | `127.0.0.1:<apps.port>` | generated into `admin/nginx/projects.conf` from the DB |

**Inside the app.** `src/proxy.ts` (Next 16's renamed middleware) gates every
route behind the signed `admin_session` cookie. Pages are React Server
Components that read live signals and the DB. Mutations go through Server
Actions (`src/app/actions.ts`, Zod-validated) or `/api/*` route handlers. The
custom server `admin/server.mjs` wraps Next and also handles the `/pty`
WebSocket upgrade, authenticating it with the same cookie, because the Next
proxy does not run for raw upgrades.

**Process model.** Everything runs as `genie`. Both admin units use
`KillMode=process`, so restarting the dashboard does **not** kill the project
dev servers, tmux sessions or agent runs it spawned (all detached). Two root-owned
helpers are the only privileged operations the app needs by design:
- `admin-ctl`: `deploy [--migrate]`, `dev-start|dev-stop|dev-restart`, `status`
- `ft-nginx-reload`: `nginx -t && systemctl reload nginx`

Both are granted through `/etc/sudoers.d/admin-supervisor`.

### Ports

| Port | Bound by | Purpose |
|------|----------|---------|
| 3000 | nginx | Public entry point (the only port meant to be exposed) |
| 3001 | `deploy/setup-server.mjs` | Setup wizard, **only during install**. Also `server.mjs`'s default `PORT` if unset |
| 3002 | `admin.service` | Admin, production (`/admin`) |
| 3003 | `admin-dev.service` | Admin, dev / hot reload (`/admin-dev`), on demand |
| 5432 | PostgreSQL | Dashboard DB (localhost) |
| 8880 | Kokoro-FastAPI (optional) | Local neural TTS |
| per app | supervised apps | Whatever port you assign in the UI (routed under `/projects/…`) |

> The admin instances bind to `127.0.0.1` (installer units use `-H 127.0.0.1`,
> `server.mjs` defaults to `HOST=127.0.0.1`). Only nginx is public. See
> [Security](#security).

### Directory layout

```
/opt/project
├── admin/                    Next.js 16 dashboard ("Projects Supervisor")
│   ├── server.mjs            Custom server: Next + the /<basePath>/pty WebSocket
│   ├── server/pty.mjs        PTY ⇄ WebSocket bridge (tmux attach via node-pty)
│   ├── src/proxy.ts          Auth gate (Next 16 Proxy)
│   ├── src/app/              App Router pages + /api route handlers + actions.ts
│   ├── src/components/       UI (dashboard, terminal dock, DB explorer, diagrams, …)
│   │   └── ui/               shadcn/ui primitives
│   ├── src/lib/              Server-only domain logic (signals, scan, runner,
│   │                         terminals, agents, stats, services, docker, chrome,
│   │                         nginx, deploy, db-explorer, crypto, session, railway, …)
│   ├── src/store/            subjecto stores (UI, runs, terminals, voice, jarvis)
│   ├── src/db/               Drizzle schema + pg Pool
│   ├── drizzle/              SQL migrations + snapshots (0000 … 0008)
│   ├── scripts/              agent-run.mjs (detached agent orchestrator),
│   │                         stats-history.mjs (cron sampler)
│   ├── ops/                  systemd units, admin-ctl, ft-nginx-reload, sudoers,
│   │                         reference nginx site
│   ├── nginx/projects.conf   GENERATED per-app nginx locations (included by the site; not in git)
│   ├── docs/                 Architecture diagram (Mermaid source + PNG)
│   └── AGENTS.md / CLAUDE.md Notes for coding agents working on the app
├── agents/                   Markdown agents (*.md) and pipelines/ (*.md)
├── tools/                    playwright-core (headless browser for UI checks)
│   └── local-genie-mcp/      stdio MCP server for project tasks/notes
├── deploy/                   install.sh, setup-server.mjs (wizard), test-docker.sh,
│   └── vendor/vps-stats/     vendored private @genie/vps-stats (stats daemon)
├── projects/                 Supervised apps (git-ignored, each its own repo)
├── .mcp.json                 MCP server registry (git-ignored, holds a token)
├── .run-logs/                Agent run history (git-ignored, created at runtime)
├── .stats-history/           Persistent stats history (git-ignored, runtime)
└── AGENTS.MD / CLAUDE.MD     Top-level notes for agents on the server
```

---

## Requirements

| Component | Version | Needed for |
|-----------|---------|------------|
| Ubuntu | 24.04 (the installer warns on others but continues) | everything (apt-based installer) |
| Node.js | 20.x (installer pins the NodeSource 20.x line) | admin, tools, MCP server, stats daemon |
| npm | 10.x (ships with Node 20) | |
| PostgreSQL | 17 from the PGDG repo (falls back to distro 16) | dashboard DB |
| nginx | distro package (1.24 on 24.04) | public entry point |
| tmux | distro package (3.4 on 24.04) | Terminals |
| git | distro | project signals, install/upgrade |
| build-essential | distro | building `node-pty` |
| cron | distro | stats history sampler |
| Claude Code CLI (`claude`) | latest (`npm i -g @anthropic-ai/claude-code`), **logged in** as `genie` | agent runs, Jarvis narrate/ask, Claude terminals |
| `agent-browser` | latest (`npm i -g agent-browser`) | Chrome live view, browser-using agents |
| Playwright Chromium | matching `tools/package.json` | UI verification scripts in `tools/` |
| *optional* code-server | latest | VS Code link |
| *optional* Docker | any | Docker page, Kokoro TTS |
| *optional* `@playwright/test` (global) | any | Chrome page screenshots |
| *optional* Kokoro-FastAPI | any (Docker, `:8880`) | neural TTS (browser voice otherwise) |

Hardware: the installer and prod build run comfortably on a small VM. Budget
memory for the supervised apps and headless Chrome instances, which are about
1.3 GB each according to the code comments.

---

## Installation

All three paths produce the same layout: code in `/opt/project`, owned by
`genie`, with Postgres, the admin units, nginx on :3000 and the stats daemon.

### Option A: the Genie "genie-local" recipe

If you manage VMs with the companion **Genie** manager
([paulbrie/genie](https://github.com/paulbrie/genie)), apply the
**"Genie Local (Projects Supervisor)"** recipe (slug `genie-local`) to a fresh
Ubuntu 24.04 VM. The recipe definition is in
`packages/manager/src/default-recipes.ts` in that repo.

**Inputs (secrets modal):**

| Name | Required | Description |
|------|----------|-------------|
| `GITHUB_PAT` | yes (as the recipe is written) | Token used **only** to clone the repo. The remote URL is scrubbed right after the clone and the token is never stored on the VM. |
| `PUBLIC_HOST` | no | Public hostname, passed to the installer (skips the interactive wizard). |
| `ADMIN_PASSWORD` | no | Dashboard password for user `admin`. Generated if empty. |
| `GENIE_VPS_TOKEN` | no | Bearer token for the `genie-*` MCP servers in `.mcp.json`. A placeholder is written if empty. The servers themselves are only configured when the recipe passes `GENIE_API_URL` to the installer. |

**Fresh install path** (no `/opt/project/.git` yet):
1. Forces IPv4 DNS, installs `git curl ca-certificates`.
2. Clones the repo (full clone) into `/tmp/genie-local-src`, resets the remote
   URL to the token-less one and chowns it to `genie`.
3. Runs `deploy/install.sh` with `SOURCE_DIR=/tmp/genie-local-src`,
   `INSTALL_CODE_SERVER=0` (code-server belongs to Genie's separate
   "VS Code (code-server)" recipe) and whichever of `PUBLIC_HOST`,
   `ADMIN_PASSWORD`, `GENIE_VPS_TOKEN` you provided. Output goes to
   `/var/log/genie-local-install.log`, with ANSI colors stripped.
4. Deletes the temp clone.

**Upgrade path** (re-applying on a box that already has `/opt/project/.git`).
This path skips `install.sh` on purpose:
1. `git fetch` from the fresh clone, then `git reset --hard FETCH_HEAD` as
   `genie`. Untracked files (`admin/.env.local`, `.mcp.json`, `projects/`)
   survive.
2. `npm install` in `admin`, `tools`, `tools/local-genie-mcp`.
3. `npm run db:migrate`, with `DATABASE_URL` read from `admin/.env.local`.
4. `systemctl restart admin.service genie-stats.service` and `reload nginx`.

> The upgrade path does **not** rebuild `.next-prod`. Because `admin.service`
> serves the production build, run `sudo admin-ctl deploy` afterwards (or use the
> Deploy panel) to make UI/server code changes go live.

**Health check (both paths).** `admin.service` must be active within about
90 s, and `http://127.0.0.1:3000/admin/login` must return **200** within about
60 s, or the apply fails. On success the recipe prints the dashboard URL and the
login read from `.env.local`, and warns if `.mcp.json` still has the token
placeholder.

**Recipe commands** available afterwards include services status, admin status
and logs, install log tail, a dashboard probe, "show dashboard login", MCP token
status, restart admin and run DB migrations.

**Uninstall** disables and removes `admin.service` and the `ft-admin` nginx
site. It leaves `/opt/project`, the database, genie-stats and code-server in
place.

> If `PUBLIC_HOST` is left empty, `install.sh` starts its interactive setup
> wizard and **blocks for up to an hour** waiting for someone to open the box's
> URL and confirm the host. For unattended recipe runs, always provide
> `PUBLIC_HOST`.

### Option B: the automated installer (`deploy/install.sh`)

On a fresh Ubuntu 24.04 machine:

```bash
git clone https://github.com/paulbrie/genie-local.git /tmp/genie-local
sudo /tmp/genie-local/deploy/install.sh
```

**Interactive (no `PUBLIC_HOST`).** The installer brings nginx up on :3000 with
a temporary `genie-setup` site that proxies to the setup wizard
(`deploy/setup-server.mjs`, :3001). The installer prints a **one-time setup
code**, and a ready-made `https://<host>/?token=<code>` link, to its console.
Open the box's public URL in a browser and enter the code; the form refuses
submissions without it, so nobody else who finds the page first can take over
the box. The wizard detects the host you reached it at (from `X-Forwarded-Host`/`Host`) and
asks you to confirm it. It also asks for an admin username and password
(8–64 characters, a restricted shell-safe charset) and whether to run the dev
instance as a daemon. The same page then streams install progress (deps → db →
migrate → build → services → start → ready). When the app answers, nginx is
switched to the real site and the wizard shuts down.

**Unattended.** Pass the host (and optionally the secrets) explicitly:

```bash
sudo PUBLIC_HOST=admin.example.com \
     ADMIN_USER=admin ADMIN_PASSWORD='choose-a-strong-one' \
     DB_PASSWORD='another-strong-one' GENIE_VPS_TOKEN='<token>' \
     /tmp/genie-local/deploy/install.sh
```

What it does, in order (section numbers match the script):

| § | Step |
|---|------|
| 0 | Preflight (root, OS check) |
| 1 | apt: `ca-certificates curl gnupg git tmux openssl sudo lsb-release nginx build-essential`. PostgreSQL `$PG_MAJOR` from PGDG (distro fallback) |
| 2 | Node.js 20 from NodeSource |
| 2b | Setup wizard (only if `PUBLIC_HOST` is unset) |
| 3 | Create user `genie` (`--disabled-password`, added to the `sudo` group) |
| 4 | Global npm: `@anthropic-ai/claude-code`, `agent-browser`. Copies the vendored `@genie/vps-stats` into the global `node_modules` |
| 5 | Place code in `INSTALL_DIR` (copy `SOURCE_DIR` or `git clone --depth 1 REPO_URL`). **Skipped if `admin/package.json` already exists.** Creates `projects/` |
| 6 | `npm install` in `admin`, `tools`, `tools/local-genie-mcp`. Playwright Chromium (+ system deps) |
| 7 | Postgres role + DB (`ALTER ROLE … PASSWORD` if the role exists) |
| 8 | Write `admin/.env.local` (chmod 600) **only if it does not exist** |
| 9 | Write `.mcp.json` **only if it does not exist** |
| 10 | `npm run db:migrate` (failure is a warning) |
| 11 | systemd units: `genie-stats`, `admin`, `admin-dev` (`[Install]` only if `START_DEV=1`). `admin-ctl` → `/usr/local/bin` + `/etc/sudoers.d/admin-supervisor` (validated with `visudo`). Per-minute stats cron for `genie`. Optional code-server |
| 12 | nginx: `conf.d/upgrade-map.conf` (`$connection_upgrade` map), site `ft-admin`, empty `projects.conf` if missing |
| 12b | Production build into `.next-prod` (one retry). Log: `/var/log/genie-admin-build.log` |
| 13 | Enable/restart units, wait for `:3002/admin/login`, switch nginx from the wizard to the admin site |
| 14 | Print a summary and verify commands |

When it finishes, edit `/opt/project/.mcp.json` and replace
`REPLACE_WITH_GENIE_VPS_TOKEN` if you didn't pass a token.

**Dry run in Docker.** `./deploy/test-docker.sh` builds a privileged, systemd-enabled
Ubuntu 24.04 container (Docker with cgroup v2 required), copies your working tree
in as `SOURCE_DIR` and runs the installer. With `PUBLIC_HOST` set it runs
unattended. Otherwise it drives the wizard with `WIZARD_HOST` (default
`genie.test.local`), `WIZARD_USER` and `WIZARD_PASS`. It then checks service
states, `GET /` → 302, `GET /admin/login` → 200 and the stats feed. The container
is left running as `genie-install-test`. `INSTALL_CODE_SERVER` defaults to `0`
there. See [`deploy/README.md`](deploy/README.md).

### Option C: manual install, step by step

Use this if you want to understand or customize each piece. Commands run as a
sudoer and assume the user `genie` exists
(`sudo adduser --disabled-password --gecos "" genie`).

**1. System packages**

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git tmux openssl lsb-release nginx build-essential cron
# PostgreSQL 17 (PGDG) — or `apt install postgresql` for the distro version
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-17 postgresql-contrib-17
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
# Global CLIs
sudo npm install -g @anthropic-ai/claude-code agent-browser
```

Then log in to Claude Code once as `genie` (`sudo -iu genie claude`) so headless
runs can authenticate.

**2. Code and dependencies**

```bash
sudo mkdir -p /opt/project && sudo chown genie:genie /opt/project
sudo -u genie git clone https://github.com/paulbrie/genie-local.git /opt/project
sudo -u genie mkdir -p /opt/project/projects
cd /opt/project/admin               && sudo -u genie npm install
cd /opt/project/tools               && sudo -u genie npm install
cd /opt/project/tools/local-genie-mcp && sudo -u genie npm install
# Headless Chromium for tools/ (system libs need root, binary goes to ~genie/.cache)
sudo node /opt/project/tools/node_modules/playwright-core/cli.js install-deps chromium
sudo -u genie node /opt/project/tools/node_modules/playwright-core/cli.js install chromium
```

`admin/.npmrc` sets `legacy-peer-deps=true` (an xterm addon has a stale peer
range), and a `postinstall` hook makes `node-pty`'s `spawn-helper` executable.

**3. Stats daemon**

```bash
sudo cp -r /opt/project/deploy/vendor/vps-stats "$(npm root -g)/@genie/vps-stats"
```

**4. Database**

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE admin_app LOGIN PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE admin_dashboard OWNER admin_app;
SQL
```

**5. `admin/.env.local`** (see [Configuration](#configuration) for every key)

```bash
sudo -u genie tee /opt/project/admin/.env.local >/dev/null <<EOF
DATABASE_URL=postgresql://admin_app:CHANGE_ME_DB_PASSWORD@localhost:5432/admin_dashboard
PROJECTS_ROOT=/opt/project/projects
APP_ENC_KEY=$(openssl rand -base64 32)
ADMIN_USER=admin
ADMIN_PASSWORD=CHANGE_ME_ADMIN_PASSWORD
EOF
sudo chmod 600 /opt/project/admin/.env.local
```

> `APP_ENC_KEY` must be **base64 encoding exactly 32 bytes**. Generate it with
> `openssl rand -base64 32`. `src/lib/crypto.ts` rejects any other length when
> encrypting DB-explorer passwords. The installer currently writes
> `openssl rand -hex 32`, which decodes to 48 bytes. See
> [Known gaps](#known-gaps-and-doc-drift).

**6. Migrations**

```bash
cd /opt/project/admin && sudo -u genie npm run db:migrate
```

`drizzle.config.ts` loads `.env.local` itself. A real `DATABASE_URL` env var
takes precedence.

**7. Production build**

```bash
cd /opt/project/admin
sudo -u genie env -u TURBOPACK APP_BASE_PATH=/admin NEXT_PUBLIC_BASE_PATH=/admin \
  APP_DIST_DIR=.next-prod NODE_ENV=production node node_modules/next/dist/bin/next build --webpack
```

This is exactly what `admin-ctl deploy` runs. Its comment explains that the
default Turbopack production build fails to prerender `/_global-error`.

**8. systemd units.** Use the reference units in `admin/ops/`. They start the
custom `server.mjs`, which is required for the terminal PTY WebSocket. Fill in
`APP_PUBLIC_HOSTS`:

```bash
sudo cp /opt/project/admin/ops/admin.service /opt/project/admin/ops/admin-dev.service /etc/systemd/system/
sudo sed -i 's/^Environment=APP_PUBLIC_HOSTS=$/Environment=APP_PUBLIC_HOSTS=admin.example.com/' \
  /etc/systemd/system/admin.service /etc/systemd/system/admin-dev.service

sudo tee /etc/systemd/system/genie-stats.service >/dev/null <<'EOF'
[Unit]
Description=Genie VM stats publisher
After=network-online.target

[Service]
Type=simple
User=genie
Group=genie
RuntimeDirectory=genie
ExecStart=/usr/bin/node /usr/lib/node_modules/@genie/vps-stats/dist/daemon.js --interval 5 --output /run/genie/stats.jsonl
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

`admin-dev.service` intentionally has no `[Install]` section. It is started on
demand with `admin-ctl dev-start`. `KillMode=process` in both admin units keeps
spawned project servers alive across restarts.

**9. Privileged helpers + sudoers**

```bash
sudo install -o root -g root -m 0755 /opt/project/admin/ops/admin-ctl /usr/local/bin/admin-ctl
sudo install -o root -g root -m 0755 /opt/project/admin/ops/ft-nginx-reload /usr/local/bin/ft-nginx-reload
sudo install -o root -g root -m 0440 /opt/project/admin/ops/admin-supervisor.sudoers /etc/sudoers.d/admin-supervisor
sudo visudo -cf /etc/sudoers.d/admin-supervisor
```

`admin-ctl` hardcodes `APP_DIR=/opt/project/admin`. Edit it if you install
elsewhere.

**10. Stats history cron** (as `genie`, idempotent)

```bash
sudo -u genie bash -c '( crontab -l 2>/dev/null | grep -v -F "admin/scripts/stats-history.mjs" || true; \
  echo "* * * * * /usr/bin/node /opt/project/admin/scripts/stats-history.mjs >/dev/null 2>&1" ) | crontab -'
```

**11. nginx (reverse proxy)**

```bash
sudo tee /etc/nginx/conf.d/upgrade-map.conf >/dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

sudo tee /etc/nginx/sites-available/ft-admin >/dev/null <<'EOF'
server {
    listen 3000;
    listen [::]:3000;
    server_name admin.example.com _;
    absolute_redirect off;
    client_max_body_size 100m;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;   # assumes TLS is terminated in front of nginx
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_read_timeout 300s;
    proxy_buffering off;

    location = /       { return 302 /admin; }
    location /admin     { proxy_pass http://127.0.0.1:3002; }
    location /admin-dev { proxy_pass http://127.0.0.1:3003; }

    # Per-app routes, regenerated by the dashboard when a port changes.
    include /opt/project/admin/nginx/projects.conf;
}
EOF
# The include target must exist for `nginx -t` (header only until a port is set).
mkdir -p /opt/project/admin/nginx
[ -f /opt/project/admin/nginx/projects.conf ] || \
  echo "# GENERATED from the admin DB (apps.port). Empty until a project port is set." \
    > /opt/project/admin/nginx/projects.conf
sudo ln -sf /etc/nginx/sites-available/ft-admin /etc/nginx/sites-enabled/ft-admin
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

- Do **not** add `auth_basic`. Auth happens in the app, and a Basic-Auth prompt
  would shadow the login page.
- If nginx is directly internet-facing, terminate TLS here (certbot or similar)
  or put a TLS proxy in front, since `X-Forwarded-Proto` is hardcoded to `https`.
- `admin/nginx/projects.conf` is not in git (generated, and ignored): it is
  created header-only above (and by `install.sh`) so the `include` is always
  valid, then regenerated from the database whenever you save an app port in
  the UI.

**12. Start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now postgresql genie-stats.service admin.service
journalctl -u admin.service -f
```

**13. Optional extras**
- **code-server**: `curl -fsSL https://code-server.dev/install.sh | sh`. Add a
  unit (see §11 of `install.sh`) and an nginx `location /vscode/` that uses
  `auth_request` against `/admin/api/authcheck` if you want it behind the
  dashboard login.
- **Docker**: install Docker and add `genie` to the `docker` group for the
  Docker page.
- **Kokoro TTS**: run a Kokoro-FastAPI container listening on
  `127.0.0.1:8880`, or point `KOKORO_URL` at one.
- **Chrome screenshots**: `sudo npm install -g @playwright/test`.

Then open `https://admin.example.com/admin` in a real browser and log in. Add a
folder under `/opt/project/projects/` and click **Rescan**.

---

## Configuration

There is **no `.env.example`** in the repo. The tables below list every
environment variable read anywhere in `admin/`, `deploy/`, `tools/` and
`agents/`.

Where values come from:
- **`admin/.env.local`** (git-ignored, chmod 600): loaded by Next and by
  `server.mjs` (`@next/env`) for both instances, and by `drizzle.config.ts`.
- **systemd unit `Environment=` lines**: per-instance values (port, base path,
  dist dir, public hosts).
- **Build time**: `NEXT_PUBLIC_*` values are inlined into the client bundle by
  `next build`.

### Admin app: core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **yes** | none (throws on startup) | Postgres URL for the dashboard DB, e.g. `postgresql://admin_app:…@localhost:5432/admin_dashboard`. Also read by `drizzle.config.ts` and the local-genie MCP server. |
| `APP_ENC_KEY` | **yes** | none | Base64 of **32 random bytes**. It HMAC-signs the `admin_session` cookie (`src/lib/session.ts`, `server/pty.mjs`) and is the AES-256-GCM key for DB-explorer passwords (`src/lib/crypto.ts`, which enforces 32 bytes). Rotating it logs everyone out and makes stored connection passwords undecryptable. |
| `ADMIN_USER` | no | `admin` | Login username. |
| `ADMIN_PASSWORD` | **yes** | `""` | Login password. Login is refused while it is empty. |
| `PROJECTS_ROOT` | no | `/opt/project/projects` | Root scanned for projects. Its parent is the default cwd for new terminals and the default parent of `agents/`. |
| `APP_PUBLIC_HOSTS` | **yes** behind a proxy | `""` | Comma-separated public hostnames. `next.config.ts` uses it for `allowedDevOrigins` and `experimental.serverActions.allowedOrigins`. If it is missing, Server Actions (notes, tasks, rescan, ports, …) fail the CSRF check, and the dev instance's `/_next/*` requests get a 403. The proxy's CSRF check and the `/pty` WebSocket also accept `Origin`s listed here. Set per unit. |
| `APP_BASE_PATH` | no | `/admin` | Next `basePath`. Also used by `proxy.ts` for the login redirect and by `server.mjs` for the `<basePath>/pty` path. Set per unit (`/admin`, `/admin-dev`). |
| `NEXT_PUBLIC_BASE_PATH` | no | `/admin` | Client-side base path (API URLs, PTY WebSocket URL). Build-time. Must match `APP_BASE_PATH`. |
| `APP_DIST_DIR` | no | `.next` | Next `distDir`. The units use `.next-prod` and `.next-dev`, so the two instances never overwrite each other. |
| `PORT` | no | `3001` (in `server.mjs`) | Listen port. The units set `3002` (prod) and `3003` (dev). |
| `HOST` | no | `127.0.0.1` (in `server.mjs`) | Bind address for `server.mjs`. Keep loopback; nginx is the public entry point. |
| `NODE_ENV` | no | unset → dev | `production` makes `server.mjs` serve the built app. If unset, Next runs in dev mode with HMR. |

### Admin app: paths and integrations (all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_LOG_ROOT` | `/tmp/projects` | Where npm-script logs and pid files go (`<slug>.log`, `<slug>.pid`). |
| `LOGS_ROOT` | `/tmp` | Root scanned by the Logs page. |
| `STATS_FILE` | `/run/genie/stats.jsonl` | genie-stats feed. Read by the app and by `scripts/stats-history.mjs`. |
| `STATS_HISTORY_FILE` | `/opt/project/.stats-history/history.jsonl` | Persistent history (cron writes it, `/api/stats/history` reads it). |
| `NGINX_PROJECTS_CONF` | `/opt/project/admin/nginx/projects.conf` | File the per-app nginx locations are written to. |
| `NGINX_RELOAD_CMD` | `/usr/local/bin/ft-nginx-reload` | Helper run with `sudo -n` after regenerating it. |
| `SERVICES_CURATED_PREFIXES` | unset | Comma-separated systemd unit prefixes shown in the Services page's curated view, in addition to the built-in `genie`, `admin` and `vps-`. |
| `CLAUDE_HOME` | `~/.claude` of the service user | Source for the Claude page. |
| `HOME` | `/home/genie` if unset | Passed to the `claude` CLI for narrate/ask. |
| `KOKORO_URL` | `http://127.0.0.1:8880` | Kokoro-FastAPI (OpenAI-compatible) base URL for `/api/tts`. |
| `RAILWAY_API_TOKEN` | unset (Railway page shows "not configured") | Account-scoped Railway API token. |
| `RAILWAY_API_URL` | `https://backboard.railway.com/graphql/v2` | Railway GraphQL endpoint. |
| `DIAGRAMS_API_KEY` | unset (disabled) | When set, `/api/diagrams*` also accepts `x-api-key: <value>` without a session. |

### Agents runner (all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTS_ROOT` | `<PROJECTS_ROOT>/../agents` (i.e. `/opt/project/agents`) | Where agent/pipeline Markdown lives. |
| `AGENT_RUNS_ROOT` | `/opt/project/.run-logs` | Run logs, progress, specs, scratch dirs, concurrency slots. |
| `AGENT_RUN_SCRIPT` | `admin/scripts/agent-run.mjs` | Detached orchestrator script. |
| `CLAUDE_BIN` | `claude` | CLI used for agent runs. Narrate/ask always call `claude` from `PATH`. |
| `AGENT_MAX_CONCURRENT` | `3` | Concurrent runs. Extra runs wait as `queued`. |
| `AGENT_DEFAULT_TIMEOUT_SEC` | `1800` | Per-invocation wall-clock timeout when an agent doesn't set `timeout:`. |
| `AGENT_RUNS_RETENTION_DAYS` | `30` | History auto-prune window. |
| `AGENT_RUN_NOTIFY_WEBHOOK` | unset | If set, a JSON summary (state, error, usage, artifacts) is POSTed here when a run finishes. |

### local-genie MCP server (`tools/local-genie-mcp`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | read from `ADMIN_ENV_FILE` | Same DB as the dashboard. |
| `ADMIN_ENV_FILE` | `/opt/project/admin/.env.local` | File parsed for `DATABASE_URL` when the env var is unset. |

### Stats daemon (`deploy/vendor/vps-stats`, optional push to a Genie manager)

The daemon always writes NDJSON to `--output`. It also POSTs each sample to
`<GENIE_MANAGER_URL>/api/vps/stats`, but only when **all four** of these are set
(the installer sets none of them):

| Variable | Description |
|----------|-------------|
| `GENIE_MANAGER_URL` | Manager base URL |
| `GENIE_STATS_TOKEN` | Bearer token |
| `GENIE_PROJECT_ID` | Project id |
| `GENIE_INSTANCE_ID` | Instance id |

CLI flags: `--interval <seconds>` (default 5), `--output <file>`.

### Installer (`deploy/install.sh`)

| Variable | Default | Description |
|----------|---------|-------------|
| `GENIE_USER` | `genie` | Unix user that owns and runs everything. |
| `REPO_URL` | `https://github.com/paulbrie/genie-local.git` | Cloned when `SOURCE_DIR` is unset. |
| `SOURCE_DIR` | unset | Copy this local tree instead of cloning. |
| `INSTALL_DIR` | `/opt/project` | Install root. |
| `PUBLIC_HOST` | unset → wizard | Public hostname, written to `APP_PUBLIC_HOSTS` and the nginx `server_name`. Setting it skips the wizard. |
| `DB_NAME` / `DB_USER` | `admin_dashboard` / `admin_app` | Postgres DB/role. |
| `DB_PASSWORD` | generated | Role password. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / generated | Dashboard login. |
| `GENIE_API_URL` | unset | Base URL of a Genie manager (e.g. `https://genie.example.com`). When set, the `genie-*` MCP servers are written into `.mcp.json`; when unset they are omitted. |
| `GENIE_VPS_TOKEN` | `REPLACE_WITH_GENIE_VPS_TOKEN` | Bearer token for the `genie-*` servers in `.mcp.json`. |
| `START_DEV` | `0` | `1` makes `admin-dev.service` start at boot. |
| `PG_MAJOR` | `17` | PostgreSQL major version from PGDG. |
| `INSTALL_CODE_SERVER` | `1` | Install code-server and `code-server.service`. |
| `START_SERVICES` | `1` | Enable and start the units. |
| `RUN_MIGRATIONS` | `1` | Run Drizzle migrations. |
| `SETUP_PORT_PUBLIC` | `3000` | Port of the temporary wizard nginx site. |
| `SETUP_PORT` | `3001` | Internal wizard port. |
| `SETUP_DIR` | `/tmp/genie-setup` | Wizard ⇄ installer handoff files. |

### Setup wizard (`deploy/setup-server.mjs`, set by the installer)

`SETUP_PORT` (default `3001`), `SETUP_HOST_FILE`, `SETUP_PROGRESS_FILE`,
`SETUP_USER_FILE`, `SETUP_PASS_FILE`, `SETUP_DEV_FILE` (all default to files
under `/tmp/genie-setup/`), and `SETUP_TOKEN`, the one-time setup code the form
requires. The installer generates it with `openssl rand -hex 12` and prints it to
its console. If unset (running the wizard by hand), no code is required.

### Docker test harness (`deploy/test-docker.sh`)

`PUBLIC_HOST` (unattended mode), `WIZARD_HOST` / `WIZARD_USER` / `WIZARD_PASS`
(wizard mode, defaults `genie.test.local` / `admin` / `Testpass123`),
`INSTALL_CODE_SERVER` (default `0`).

### `.mcp.json` (Claude Code MCP registry)

Located at `/opt/project/.mcp.json` and git-ignored. The installer always
writes the `local-genie` server. The four `genie-*` servers (a Genie manager's
tracker/security/notify/storage endpoints) are added only when `GENIE_API_URL`
is set, so a standalone install depends on no hosted service:

```json
{
  "mcpServers": {
    "local-genie": {
      "command": "node",
      "args": ["/opt/project/tools/local-genie-mcp/server.mjs"]
    },
    "genie-tracker":  { "type": "http", "url": "<GENIE_API_URL>/api/vps/mcp/tracker",  "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-security": { "type": "http", "url": "<GENIE_API_URL>/api/vps/mcp/security", "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-notify":   { "type": "http", "url": "<GENIE_API_URL>/api/vps/mcp/notify",   "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } },
    "genie-storage":  { "type": "http", "url": "<GENIE_API_URL>/api/vps/mcp/storage",  "headers": { "Authorization": "Bearer <GENIE_VPS_TOKEN>" } }
  }
}
```

`install.sh` hardcodes the Genie manager's API host. `local-genie` needs no
token. The `agent-browser` MCP used by browser agents comes from the Claude Code
environment, not from this file. Some agents (`railway-logs`) reference a
`railway` MCP server, which you need to register yourself.

---

## Database

PostgreSQL database `admin_dashboard`, role `admin_app`, managed with
**Drizzle ORM** (`admin/src/db/schema.ts`, `admin/drizzle.config.ts`). The app
uses a `pg` pool with a maximum of 5 connections.

| Table | Purpose |
|-------|---------|
| `projects` | One row per top-level directory under `PROJECTS_ROOT` (`slug` unique, `path`, `name`, `archived`). |
| `apps` | Apps inside a project (`project_id` → projects, cascade). `slug` is the subdir name, `''` for a root app. Also stores `is_git` and `port` (drives nginx routing). Unique on `(project_id, slug)`. |
| `status_snapshots` | Point-in-time app signals: branch, dirty, ahead/behind, last commit, dir mtime, `size_bytes` (bigint), raw JSON blob. |
| `notes` | Per-project notes with manual `position`. |
| `tasks` | Per-project tasks: `title`, `description`, `done`, `position`. |
| `connections` | DB-explorer connections (`engine` `postgres` or `mysql`, host, port, user, `password_enc` = AES-GCM `v1:iv:tag:ciphertext`, default DB). |
| `saved_queries` | Named SQL per connection + database (cascade on connection delete). |
| `diagrams` | Text diagrams (`format` default `mermaid`, `source`, `archived_at` soft delete). |

Migrations live in `admin/drizzle/` (`0000` … `0008`, plus `meta/` snapshots and
`_journal.json`).

```bash
cd /opt/project/admin
npm run db:generate   # after editing src/db/schema.ts → writes a new drizzle/NNNN_*.sql
npm run db:migrate    # apply pending migrations
npm run db:studio     # Drizzle Studio (browse the DB)
```

`drizzle.config.ts` loads `.env.local` itself (`drizzle-kit` doesn't). To run a
migration and a prod rebuild in one step, use `sudo admin-ctl deploy --migrate`.

---

## Running, building, deploying and upgrading

### npm scripts (`admin/package.json`)

| Script | Runs |
|--------|------|
| `npm run dev` | `node server.mjs` (Next dev + PTY WebSocket) |
| `npm run build` | `next build` |
| `npm start` | `NODE_ENV=production node server.mjs` |
| `npm run lint` | `eslint` |
| `npm run db:generate` / `db:migrate` / `db:studio` | drizzle-kit |

There is no test suite.

### Local development

The app is written to run on a Genie box (paths under `/opt/project`, tmux,
systemd, `/proc`), but it boots anywhere Node 20 and Postgres are available:

```bash
cd admin
cp /dev/null .env.local   # then fill in DATABASE_URL, APP_ENC_KEY, ADMIN_PASSWORD, PROJECTS_ROOT
npm install
npm run db:migrate
PORT=3001 npm run dev     # → http://localhost:3001/admin
```

Without nginx, open the app directly at `http://localhost:<PORT>/admin`.
Server-only modules (`src/lib/signals.ts`, `runner.ts`, `terminals.ts`,
`chrome.ts`, …) must never be imported from client components. Read
`admin/AGENTS.md` before changing the app. It covers Next 16 specifics: the
`proxy.ts` rename, `params` as a Promise, and `force-dynamic` pages.

### On the server: prod vs dev instance

- **`/admin` (prod, `admin.service`)** serves the `.next-prod` build. Source
  edits do **not** show up until you deploy.
- **`/admin-dev` (dev, `admin-dev.service`)** runs `next dev` from the same
  working copy with hot reload. Use it to preview changes on the live box.

```bash
sudo admin-ctl dev-start | dev-stop | dev-restart   # control /admin-dev
sudo admin-ctl deploy                               # build .next-prod (webpack) → restart admin.service
sudo admin-ctl deploy --migrate                     # drizzle migrate first
sudo admin-ctl status                               # prod=…, dev=…, deploy=SUCCESS|FAILED|RUNNING <epoch>
```

`deploy` runs detached and holds a lock, so two deploys can't overlap. Progress
streams to `/tmp/projects/admin-deploy.log`, which you can read on the Logs page.
The same controls are on the **Services** page's Deploy panel.

### Upgrading in place

Re-running `install.sh` does **not** update an existing tree. The canonical
upgrade (the same one the Genie recipe performs, plus the rebuild):

```bash
cd /opt/project
sudo -u genie git fetch origin && sudo -u genie git reset --hard origin/main   # untracked .env.local/.mcp.json/projects/ survive
for p in admin tools tools/local-genie-mcp; do (cd /opt/project/$p && sudo -u genie npm install --no-audit --no-fund); done
sudo admin-ctl deploy --migrate          # migrate + rebuild .next-prod + restart admin.service
sudo systemctl restart genie-stats.service
```

If `admin/ops/*` changed (units, `admin-ctl`, sudoers), reinstall them by hand
as in [Option C](#option-c-manual-install-step-by-step) steps 8–9.

### Health checks

There is no dedicated health endpoint. Use:

```bash
systemctl is-active admin.service genie-stats.service postgresql nginx
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/             # 302
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/admin/login  # 200
sudo -u genie sudo -n admin-ctl status
tail -n 3 /run/genie/stats.jsonl                                            # stats feed is live
```

The Genie recipe treats "admin.service active **and** `/admin/login` → 200 via
:3000" as healthy. For UI checks, use a real browser through the public host
(see [`tools/`](#server-tooling-tools)). `curl` won't show hydration errors or
dev-origin 403s.

### Day-2 operations

```bash
journalctl -u admin.service -f            # prod logs (admin-dev.service for dev)
journalctl -u genie-stats.service -f
sudo systemctl restart admin.service      # after editing .env.local or the unit
sudo nginx -t && sudo systemctl reload nginx
ls /tmp/projects/                         # npm-script logs + pids, deploy log
ls /opt/project/.run-logs/                # agent runs
```

---

## HTTP API overview

All routes sit under the base path (e.g. `/admin/api/...`). They require the
session cookie, except `/api/login` and `/api/logout`, plus `/api/diagrams*`
when the `x-api-key` matches. Unauthenticated `/api/*` calls get
`401 {"error":"unauthorized"}`.

| Area | Routes |
|------|--------|
| Auth | `POST /api/login` `{username,password}` → sets cookie · `POST /api/logout` · `GET /api/authcheck` (200/401, for nginx `auth_request`) |
| Projects | `POST /api/scan` (full rescan, cron-friendly) · `GET /api/run-status` |
| Stats | `GET /api/stats` · `GET /api/stats/history?range=1d\|7d\|30d` |
| Processes | `GET /api/processes` · `POST /api/processes/kill` `{pid, signal?, tree?}` |
| Services | `GET /api/services` · `POST /api/services/action` · `GET /api/services/logs` |
| Docker | `GET /api/docker` · `POST /api/docker/action` · `GET /api/docker/logs` |
| Chrome | `GET /api/chrome` · `GET /api/chrome/pages?dir=` · `GET /api/chrome/screenshot?dir=&url=` · `POST /api/chrome/kill` |
| Terminals | `GET/POST/DELETE /api/terminals` · `GET/POST/PATCH /api/terminals/[name]` · `POST /api/terminals/[name]/image` · WebSocket `<basePath>/pty` |
| Voice | `POST /api/tts` `{text, voice?, speed?}` · `POST /api/narrate` · `POST /api/ask` `{question}` |
| Logs | `GET /api/logs` · `GET /api/logs/tail` |
| Claude | `GET /api/claude/sessions` · `…/sessions/transcript` · `…/logs` · `…/logs/tail` · `…/memories` · `…/memories/read` |
| DB explorer | `GET/POST /api/db/connections` · `PUT/DELETE /api/db/connections/[id]` · `GET /api/db/[id]/{databases,tables,test}` · `GET/POST/PATCH/DELETE /api/db/[id]/rows` · `POST /api/db/[id]/query` · `GET/POST /api/db/[id]/queries` · `DELETE /api/db/queries/[qid]` |
| Diagrams | `GET/POST /api/diagrams` (`?archived=true`) · `GET/PUT/DELETE /api/diagrams/[id]` · `POST /api/diagrams/validate` `{source}` → `{ok, error?, line?, diagramType?}` |
| Railway | `GET /api/railway/projects` · `GET /api/railway/deployments` · `GET /api/railway/logs?deploymentId=&limit=&filter=` |

Notes, tasks, ports, script start/stop, deploy, agents and diagram UI actions
are **Server Actions** in `src/app/actions.ts`, not REST routes.

Example (agent creating a diagram with the API key):

```bash
curl -X POST https://admin.example.com/admin/api/diagrams \
  -H "x-api-key: $DIAGRAMS_API_KEY" -H 'content-type: application/json' \
  -d '{"title":"Flow","source":"flowchart LR\n  A-->B"}'
```

---

## The local-genie MCP server

`tools/local-genie-mcp/server.mjs` is a **stdio MCP server** (built on
`@modelcontextprotocol/sdk`) that gives Claude direct access to the dashboard's
`tasks` and `notes` tables. Changes show up live in the UI and vice versa. Every
operation is scoped by **project slug**.

| Tool | Args | Purpose |
|------|------|---------|
| `list_projects` | none | Slugs and names of tracked projects |
| `list_tasks` | `project`, `status?` (`all`/`open`/`done`) | List tasks, top to bottom |
| `create_task` | `project`, `title`, `description?` | Add a task at the top |
| `update_task` | `project`, `id`, `title?`, `description?` | Edit a task |
| `set_task_status` | `project`, `id`, `done` | Mark done / not done |
| `delete_task` | `project`, `id` | Remove a task |
| `reorder_tasks` | `project`, `orderedIds` | Set manual order |
| `list_notes` | `project` | List notes |
| `add_note` | `project`, `body` | Add a note at the top |
| `update_note` | `project`, `id`, `body` | Edit a note |
| `delete_note` | `project`, `id` | Remove a note |
| `reorder_notes` | `project`, `orderedIds` | Set manual note order |

**Register it** in `/opt/project/.mcp.json` (the installer does this):

```json
{
  "mcpServers": {
    "local-genie": { "command": "node", "args": ["/opt/project/tools/local-genie-mcp/server.mjs"] }
  }
}
```

The server connects with `DATABASE_URL`, or reads it from
`/opt/project/admin/.env.local` (override the path with `ADMIN_ENV_FILE`), so
the user running Claude Code must be able to read that file. Claude Code loads
`.mcp.json` at session start, so restart the session after editing it. If
`node_modules` is missing: `cd /opt/project/tools/local-genie-mcp && npm install`.

---

## Agents and pipelines

Defined as Markdown in [`agents/`](agents/README.md) and managed from the
**Agents** page:

- **Agent** = `agents/<slug>.md`. YAML frontmatter is the config, the body is the
  system prompt. `{{name}}` placeholders interpolate values from the shared
  context.
- **Pipeline** = `agents/pipelines/<slug>.md` with `inputs` and an ordered
  `steps:` list (`- agent: <slug>`, optional `as: <label>`). The context is
  **cumulative**: each step sees the pipeline inputs plus every earlier output.
  A later output with the same name overwrites an earlier one.

**Frontmatter:** `name`, `description` (required), `model`, `tools`, `inputs`,
`outputs`, `maxTurns`, `timeout` (seconds), `permissionMode`
(`default|plan|acceptEdits|bypassPermissions`), `cwd`.

**How a run works.** `src/lib/agent-runner.ts` writes a spec and spawns
`admin/scripts/agent-run.mjs` detached, so the run survives admin restarts. Each
step runs as `claude -p … --output-format stream-json --allowedTools <tools>`,
plus `--max-turns`/`--permission-mode` when set. Files under `AGENT_RUNS_ROOT`
per run: `<runId>.log`, `.progress.json`, `.spec.json`, `.pid` and a `.cwd`
scratch dir. A filesystem semaphore enforces `AGENT_MAX_CONCURRENT`. Dead runs
are reconciled to `failed`. Inputs are capped at 50 KB each and agent files at
256 KB.

**Tool policy.** `tools:` is passed verbatim as `--allowedTools`. If it is
**omitted**, a run gets a read-only set (`Read, Grep, Glob, WebSearch,
WebFetch`), not every tool. Write-enabled runs default to a per-run scratch dir.
They still run as `genie`, so they can write anywhere `genie` can.

**Included definitions**

| Agents | Pipelines |
|--------|-----------|
| `researcher`, `writer`, `critic` | `blog-post`: researcher → writer → critic → writer (as reviser) |
| `web-vitals-auditor`, `perf-advisor` | `site-audit`: web-vitals-auditor → perf-advisor |
| `railway-logs` (needs a `railway` MCP), `railway-discovery` | none |

**Running them.** From the UI, open **Agents → Run**, fill in the inputs and
optionally **Preview** the exact prompts (costs no tokens) or set overrides.
Watch the run window, check the history and re-run. Runs require a logged-in
`claude` CLI for the service user. There is no CLI wrapper. The orchestrator
takes a spec JSON that the app generates.

See [`agents/README.md`](agents/README.md) for the full format reference.

---

## Server tooling (`tools/`)

- **Headless browser.** `playwright-core` is installed in `tools/node_modules`,
  with Chromium in `~/.cache/ms-playwright/`. Use it to verify UI changes:

  ```js
  // run from /opt/project/tools so playwright-core resolves
  import { chromium } from "playwright-core";
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await (await browser.newContext()).newPage();
  await page.goto("https://admin.example.com/admin/login");
  // log in via the form, or set the admin_session cookie on the context
  await browser.close();
  ```

  Go through the **public host**, not `127.0.0.1:3002`. The dev instance 403s
  cross-origin `/_next/*` from unlisted origins.
- **local-genie MCP**: see [above](#the-local-genie-mcp-server).

---

## Security

Treat the dashboard password as equivalent to **shell access on the server**.
The model is "one trusted operator behind a strong login". It is not built for
multiple users.

### Authentication
- **One shared account.** `ADMIN_USER` / `ADMIN_PASSWORD` come from
  `admin/.env.local`. `POST /api/login` compares both in constant time and
  refuses logins while `ADMIN_PASSWORD` is empty, so there is no default
  password.
- **Brute-force throttle.** After 10 failed logins from one client IP
  (`X-Real-IP` from nginx) within 15 minutes, `/api/login` answers `429` until
  the window expires. The counter is in memory, so it resets on restart.
- **Session.** A stateless `admin_session` cookie
  (`base64url(payload).HMAC-SHA256`, keyed by `APP_ENC_KEY`) with a 7-day
  expiry, `HttpOnly`, `SameSite=Lax` and `Path=/`. `Secure` is set when
  `X-Forwarded-Proto` is `https`. The signature is checked in constant time and
  verification fails closed when `APP_ENC_KEY` is missing. Logout clears the
  cookie but doesn't revoke the token. Rotating `APP_ENC_KEY` invalidates all
  sessions.

### Enforcement points
- **`src/proxy.ts`** runs before every route:
  - Any request carrying a `Next-Action` header (a Server Action call) without
    a valid session gets `401`. This matters because Next.js executes Server
    Actions on any page path, including the public `/login`.
  - Pages redirect to `/login` and `/api/*` returns `401` unless the session is
    valid.
  - The only unauthenticated paths are `GET /login`, `/api/login`,
    `/api/logout`, and framework assets under `/_next/` plus `/favicon.ico`.
    These are matched exactly at the start of the path, so a path like
    `/api/x/_next/...` can't skip auth.
  - **CSRF:** every non-GET/HEAD/OPTIONS request with an `Origin` header must
    come from the request's own host or a host in `APP_PUBLIC_HOSTS`. Otherwise
    it gets `403`.
  - `/api/diagrams*` also accepts `x-api-key` when `DIAGRAMS_API_KEY` is set,
    compared in constant time.
- **Every Server Action** in `src/app/actions.ts` calls `requireAdmin()` first,
  as defense in depth behind the proxy.
- **The `/pty` WebSocket** (`server.mjs`) can't be seen by the proxy. It checks
  the session cookie and requires the handshake's `Origin` to match the host or
  `APP_PUBLIC_HOSTS`.
- **The setup wizard** (`deploy/setup-server.mjs`) is public during an
  interactive install. It requires a one-time setup code that `install.sh`
  generates and prints only to the installer's console (`SETUP_TOKEN`). It
  refuses further submissions once the host is confirmed.
- nginx itself does no auth.

### What a logged-in user can do
Terminals are full interactive shells as `genie`. The DB explorer runs
arbitrary SQL against any reachable database. Users can run any npm script,
signal processes owned by `genie`, start and stop Docker containers, and launch
agents with write tools. Depending on sudo configuration, they can also start
and stop systemd units.

### Privilege boundaries
- The app runs as `genie`. It only needs two root helpers, `admin-ctl` and
  `ft-nginx-reload`. Both are root-owned, take whitelisted or no arguments, and
  are granted with `NOPASSWD` in `/etc/sudoers.d/admin-supervisor`.
- `admin-ctl` never touches files in the genie-owned `/tmp/projects` as root.
  Log and status reads and writes go through `runuser -u genie`, so a planted
  symlink can't make root read or overwrite files such as `/etc/shadow`.
- The **Services** page runs `sudo -n systemctl <action> <unit>`, which that
  sudoers file doesn't cover. It only works if `genie` has broader sudo. A broad
  `NOPASSWD: ALL` turns a dashboard login into root, so decide deliberately.
- Commands are spawned with `execFile`/`spawn` and argument arrays, never shell
  strings. Unit names (which must start with an alphanumeric character), tmux
  session names, Docker IDs, Chrome dirs, project slugs and log paths are
  validated or confined to their roots. The log viewer opens files with
  `O_NOFOLLOW`. Generated nginx config only accepts `[A-Za-z0-9._-]` slugs and
  valid ports, and is checked with `nginx -t` before every reload.
- The admin's own secrets (`ADMIN_USER`, `ADMIN_PASSWORD`, `APP_ENC_KEY`,
  `DIAGRAMS_API_KEY`, and `DATABASE_URL` for terminals) are removed from the
  environment of terminals, agent runs and child apps. This prevents accidental
  leaks only. Anything running as `genie` can still read `admin/.env.local`.
- The Jarvis/Q&A `claude` calls run with all file, shell and web tools
  disallowed, from `/tmp`. Agent runs default to read-only tools unless `tools:`
  grants more.

### Secrets at rest
| Secret | Where | Protection |
|--------|-------|------------|
| DB URL, `APP_ENC_KEY`, admin password, optional Railway token / diagrams key | `admin/.env.local` | git-ignored, `chmod 600`, owned by `genie` |
| DB-explorer connection passwords | `connections.password_enc` | AES-256-GCM with `APP_ENC_KEY`, never sent to the browser |
| `GENIE_VPS_TOKEN` | `/opt/project/.mcp.json` | git-ignored, `chmod 600`, owned by `genie` |
| Wizard admin password | `/tmp/genie-setup/admin-pass` | Mode 600, written briefly during install and deleted once read |
| GitHub PAT (recipe) | none | Used for the clone only. The remote URL is reset immediately |

### Network exposure (defaults)
- nginx is the only public listener, on **:3000** over plain HTTP. It sends
  `X-Forwarded-Proto https` and assumes a TLS terminator in front of it.
- The admin instances bind to **127.0.0.1** (:3002 prod, :3003 dev). The
  installer's units pass `-H 127.0.0.1`, and `server.mjs` defaults to
  `HOST=127.0.0.1`.
- The setup server binds to 127.0.0.1:3001 and is reachable only through
  nginx, gated by the setup code.

### Known limitations
- **Hosted apps share the admin's origin.** nginx serves `/projects/<slug>` and
  `/admin` on the same host, and the session cookie is `Path=/`. Script running
  in a hosted app (an XSS bug, or a malicious frontend dependency) runs
  same-origin with the admin and can call its API with your session. If you host
  apps you don't fully trust, serve the admin on its own hostname.
- Sessions can't be revoked individually. Rotate `APP_ENC_KEY` to log everyone
  out.
- `install.sh` installs NodeSource and code-server through unpinned
  `curl | bash`, and passes the generated DB password to `psql` on the command
  line, where it is briefly visible in `ps`.

### Recommendations for exposing it to the internet
1. Terminate **TLS** in front of nginx, or on nginx itself. Never serve the
   login over plain HTTP.
2. **Firewall:** allow only 22 and the public port. Block 3001–3003, 5432 and
   8880 from outside, even though the app binds to loopback.
3. Use a long random `ADMIN_PASSWORD` and a proper `APP_ENC_KEY`
   (`openssl rand -base64 32`). For anything sensitive, add another access layer
   (VPN, IP allowlist or SSO proxy).
4. Keep `DIAGRAMS_API_KEY` unset unless an agent needs it.
5. Scope `genie`'s sudo deliberately (see Privilege boundaries).
6. If you add a `/vscode/` location for code-server, protect it with
   `auth_request /admin/api/authcheck` and keep code-server on 127.0.0.1.

---

## Known gaps and doc drift

These are mismatches found in the code as of this README. They are listed so
operators don't get surprised.

- **`install.sh` units vs `admin/ops/` units.** The installer's
  `admin.service`/`admin-dev.service` run `next start`/`next dev` directly. The
  units in `admin/ops/` run `server.mjs`, which is the only process that serves
  the `/pty` WebSocket the terminal dock needs. On installer-provisioned boxes,
  replace the units with the `ops/` versions (step 8 of Option C) for live
  terminals.
- **`ft-nginx-reload` isn't installed by `install.sh`.** The sudoers file
  references it, but only `admin-ctl` is copied. Saving an app port then fails to
  reload nginx until you install the helper (Option C step 9).
- **`APP_ENC_KEY` format.** `install.sh` (and earlier docs) generate
  `openssl rand -hex 32`, but `crypto.ts` needs base64 for exactly 32 bytes. The
  session cookie works either way, but saving a DB-explorer connection with a
  password fails until the key is replaced. Replacing it logs everyone out.
- **Prod build command differs.** `install.sh` runs `npm run build`
  (`next build`, default bundler). `admin-ctl deploy` runs
  `next build --webpack` because of a Turbopack prerender failure.
- **Not provisioned by any script here:** the Kokoro TTS container (contrary to
  a note in `admin/AGENTS.md`), Docker, the global `@playwright/test` used for
  Chrome screenshots, and the `/vscode/` nginx location.
- **Re-running `install.sh`** generates a new DB password and `ALTER ROLE`s it,
  but keeps the existing `.env.local`. This desyncs Postgres auth. Upgrade with
  the in-place procedure above instead.
- **Stale port comments.** `server.mjs`, `admin-ctl` (`dev-*` "`:3002`"),
  `admin/docs/architecture.mmd` (`:3001`) and the Genie recipe description
  ("next dev on :3001") predate the current 3002 (prod) / 3003 (dev) layout.

---

## Troubleshooting / FAQ

**Every client component hangs on "loading…" on `/admin-dev`.**
`APP_PUBLIC_HOSTS` is missing the host you're browsing from, so Next dev 403s
cross-origin `/_next/*` requests. Add the host to the unit and restart it.
`curl` won't reproduce this. Use a browser.

**Notes, tasks, rescan or port changes fail with a CSRF / 403 error.**
Same cause: Server Actions only accept origins listed in `APP_PUBLIC_HOSTS`.

**I edited code but `/admin` didn't change.**
`/admin` serves the `.next-prod` build. Run `sudo admin-ctl deploy` (or use the
Deploy panel). Preview edits on `/admin-dev` (`sudo admin-ctl dev-start`).

**`admin.service` crash-loops right after install or upgrade.**
`.next-prod` is missing or partial. Check `/var/log/genie-admin-build.log` or
`/tmp/projects/admin-deploy.log` and rebuild with `sudo admin-ctl deploy`. A
stale `.next-dev`/`.next-prod` can break type checking (TS2307), so delete the
stale directory and rebuild.

**Login keeps returning to the login page over plain `http://`.**
nginx always sends `X-Forwarded-Proto https`, so the cookie is marked `Secure`
and browsers won't keep it on an insecure origin. Serve the app over HTTPS.

**Terminals open but stay blank / "connecting".**
The unit isn't running `server.mjs`, or nginx isn't forwarding the WebSocket
upgrade (check `conf.d/upgrade-map.conf` and the `Upgrade`/`Connection`
headers). See [Known gaps](#known-gaps-and-doc-drift).

**Stats show "unavailable" / the history chart is empty.**
Check `systemctl status genie-stats` and that `/run/genie/stats.jsonl` is
growing. For history, check `crontab -l -u genie` and
`/opt/project/.stats-history/history.jsonl`.

**Saving a DB connection fails with `APP_ENC_KEY must be 32 bytes`.**
Replace the key with `openssl rand -base64 32` and restart. Existing sessions
are logged out, and previously saved passwords must be re-entered.

**Setting an app port doesn't route it.**
Install `/usr/local/bin/ft-nginx-reload` and the sudoers file. Make sure the
app's `basePath` equals its mount path (`/projects/<project>` or
`/projects/<project>/<app>`), since the prefix is not stripped.

**`npm run db:migrate` says `DATABASE_URL is not set`.**
Run it from `admin/`, where `.env.local` lives, or export `DATABASE_URL`.

**Spawned app dies with "Multiple bundler flags set: TURBOPACK=1, --webpack".**
The runner strips `TURBOPACK`/`__NEXT*`/`NEXT_RUNTIME` from child envs. If you
start apps another way from inside the admin's environment, strip them too.

**Voice is robotic.**
Kokoro isn't reachable, so `/api/tts` returns 503 and the client falls back to
the browser voice. Run Kokoro-FastAPI on `:8880` or set `KOKORO_URL`.

**Agent runs fail immediately.**
Check that `claude` is on `PATH` for `genie` (or set `CLAUDE_BIN`) and is logged
in. Also check that every agent referenced by the pipeline exists. Read the run
log under `/opt/project/.run-logs/`.

**Will restarting the dashboard kill my running apps or terminals?**
No. Both units use `KillMode=process`, and apps, tmux sessions and agent runs
are detached.

**Does the dashboard touch my own tmux sessions?**
No. It only manages sessions named `admin-*`.

---

## Contributing

- Read `admin/AGENTS.md` first. It covers the conventions and Next 16
  specifics. This Next version differs from older docs, and the in-repo guide
  lives at `node_modules/next/dist/docs/`.
- Keep server-only modules out of client components. Validate Server Action
  inputs with Zod. Spawn processes with `execFile` and argument arrays.
- Keep `src/lib/runner.ts` and `src/lib/run-slug.ts` in sync, and keep
  `server/pty.mjs` in sync with `src/lib/session.ts` and `src/lib/terminals.ts`.
  These are hand-written ports.
- Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, and commit
  the generated SQL and snapshot.
- Run `npm run lint` and do a production build
  (`sudo admin-ctl deploy` on a box, or `next build --webpack` locally) before
  opening a PR. Verify UI changes in a real browser (see `tools/`).
- Installer changes: test with `./deploy/test-docker.sh`.

---

## License

No license specified yet.
