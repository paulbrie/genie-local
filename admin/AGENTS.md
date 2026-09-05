<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Projects Supervisor (admin app)

A dashboard that supervises every project under `/opt/project/projects`. Stack:
**Next.js 16 (App Router) + Drizzle (PostgreSQL) + shadcn/ui + `subjecto`**.

## How it runs

- Served publicly at **`https://<public-host>/admin`** via nginx. The public
  host is **not hardcoded** — the setup wizard (`deploy/setup-server.mjs`)
  captures it at install time and the installer bakes it into the systemd units
  as `APP_PUBLIC_HOSTS` (read by `next.config.ts`). Public traffic → box
  **:3000** (nginx) → the app on **:3002** (prod) or **:3003** (dev).
- **Two instances from this one working copy**, differing only by per-unit env
  (`APP_BASE_PATH` / `NEXT_PUBLIC_BASE_PATH` / `APP_DIST_DIR`, see `next.config.ts`):
  - **`admin.service`** — PROD at **`/admin`** on **:3002**: `next start` serving
    the `.next-prod` build. This is the live site. Source edits do **not** show up
    until you rebuild — ship with **`sudo admin-ctl deploy`** (builds `.next-prod`
    then restarts `admin.service`; add `--migrate` to run drizzle first).
  - **`admin-dev.service`** — on-demand DEV at **`/admin-dev`** on **:3003**:
    `next dev` (`.next-dev` distDir) with hot-reload, for previewing changes on the
    live box before deploying. Not started at boot; control it via
    **`sudo admin-ctl dev-start|dev-stop|dev-restart`** (or the admin UI).
- `basePath` comes from `APP_BASE_PATH` (`/admin` prod, `/admin-dev` dev) —
  `next/link`/router/static assets are auto-prefixed. Raw `<a href>` is **not**
  prefixed: use it only to link to the live project apps at `/projects/<slug>`.
- Both units set **`KillMode=process`** so restarting them does not kill project
  dev servers launched from the UI (see `src/lib/runner.ts`). Logs:
  `journalctl -u admin.service -f` (or `-u admin-dev.service`). `admin-ctl` is a
  root-owned helper the app runs via a scoped NOPASSWD sudoers rule
  (`ops/admin-supervisor.sudoers`); deploy progress streams to
  `/tmp/projects/admin-deploy.log` (the Logs page).
- nginx config: `/etc/nginx/sites-available/ft-admin` (`sudo nginx -t &&
  sudo systemctl reload nginx` after edits) — routes `/admin`→:3002 and
  `/admin-dev`→:3003 (longest-prefix, so they never collide). It also proxies each
  project at `/projects/<name>/` → a per-port app (generated in `nginx/projects.conf`).
- **Auth is enforced in-app by `src/proxy.ts`** — Next 16's "Proxy" (the renamed
  Middleware; `middleware.ts` is deprecated). It gates every route behind a signed
  session cookie (`admin_session`, HMAC-SHA256 via `src/lib/session.ts`, key =
  `APP_ENC_KEY`), allowing only `/login`, `/api/login`, `/api/logout`, and
  `/_next/*`. Unauthed pages → redirect to `/admin/login` (form at
  `src/app/login/page.tsx`); unauthed `/api/*` → 401 JSON. `POST /api/login`
  checks `ADMIN_USER`/`ADMIN_PASSWORD` (constant-time) and sets the cookie;
  `/api/logout` clears it (Logout button in the toolbar). nginx does **not** do
  auth — no `auth_basic` (that would show a browser Basic-Auth modal instead of
  the login page). NOTE: proxy sees the basePath-STRIPPED path (`/admin/db` → `/db`).
- Server Actions require `experimental.serverActions.allowedOrigins` to include
  the public domain — the proxy changes the origin, so dropping this breaks
  notes/tasks/rescan with a CSRF error. Both this and `allowedDevOrigins` derive
  from **`APP_PUBLIC_HOSTS`** (comma-separated, set per unit); there is no
  hardcoded host. If `APP_PUBLIC_HOSTS` is empty/wrong, Server Actions 403.
- The **`/admin-dev`** instance runs `next dev` behind the proxy on a different
  host than the dev server's own origin, so its host must be in `allowedDevOrigins`
  (i.e. in `APP_PUBLIC_HOSTS`). Without it, Next 16 blocks cross-origin `/_next/*`
  dev-resource requests with **403**, client chunks fail to load, and every client
  component hangs on "loading…". `curl` won't reveal this — it sends no
  Origin/Referer; reproduce with a real browser. Prod (`next start` on `/admin`)
  has no such dev-origin restriction.

## Data & config

- Postgres: role `admin_app`, db `admin_dashboard`. `DATABASE_URL` and
  `PROJECTS_ROOT` live in `/opt/project/admin/.env.local` (git-ignored, loaded by
  `next start`). Drizzle: `npm run db:generate | db:migrate | db:studio`.
- Schema: `src/db/schema.ts`. Model is **project → apps**: a `projects` row per
  top-level dir; an `apps` row per sub-project/app (immediate subdir with `.git`
  or `package.json`, e.g. `roa/server-app`, `roa/server-admin`; `slug=''` if the
  project dir is itself an app). `status_snapshots` are **per app** (`app_id`);
  `notes` and `tasks` are **per project** (`project_id`).

## Code layout & rules

- `src/lib/signals.ts` — **server-only** git/fs/`package.json` collectors. Runs
  `git` via `execFile` (never shell-interpolate paths); guards against path
  traversal (child dirs of `PROJECTS_ROOT` only). `discoverApps()` finds a
  project's apps at depth 1; `collectApp()` gathers per-app signals; returns
  nested `ProjectSignals{ apps: AppSignals[] }`. Never import from a client component.
- `src/lib/scan.ts` — scan → upsert `projects` + each `apps` row + a per-app
  `status_snapshots` row; query helpers return projects with their apps.
- `src/app/actions.ts` — Server Actions (`'use server'`, Zod-validated) for
  notes/tasks/rescan and **app process control** (start/stop/restart/status);
  each mutating one calls `revalidatePath`.
- `src/lib/runner.ts` — **server-only** process manager, keyed per **(app,
  script)**. Any `package.json` script is runnable, each as an independent
  **detached** child (own session/process group): `npm run <script>` with
  stdout+stderr appended to `/tmp/projects/<slug>.log` where `slug =
  runSlug(project, app, script)` (e.g. `roa-server-app-dev`,
  `roa-server-app-lint`); tracked by a `<slug>.pid` file; `stopApp` signals the
  whole process group (SIGTERM→SIGKILL). So starting `build` never touches a
  running `dev`. Runs as `genie`, no sudo. **Sanitizes the child env**
  (`childEnv`): strips the admin's own `next dev` injected vars — `TURBOPACK`,
  `__NEXT*`, `NEXT_RUNTIME` — before spawning, or a spawned app whose script uses
  `--webpack` dies instantly with "Multiple bundler flags set: TURBOPACK=1,
  --webpack". Sets `PORT` from the DB. Because these live in `admin.service`'s
  cgroup, the unit sets **`KillMode=process`** so restarting admin does NOT kill
  running project servers. UI: `src/components/script-row.tsx` renders one
  Run/Stop/Restart + status dot + `/logs?file=…` deep-link **per script** in the
  detail page's Scripts list (`actions.ts` validates the script exists in the
  app's package.json). The **dashboard cards** show live running state: they poll
  `GET /api/run-status` (alive run-slugs) and match via `src/lib/run-slug.ts` —
  a pure `runSlug()`/`isAppServerRunning()` shared by server and client. An app
  reads as "running" on the dashboard when its `dev` or `start` unit is alive.
  Keep runner + run-slug in sync.
- `src/store/ui.ts` — `subjecto` `Subject`s for **UI state only** (search, view
  mode). Server data stays in RSC/DB; use `useSubject` from `subjecto/react`.
- Dashboard (`src/app/page.tsx`) and detail (`src/app/projects/[slug]/page.tsx`)
  are `dynamic = 'force-dynamic'` (they read live signals every load). `params`
  is a `Promise` — `await` it.
