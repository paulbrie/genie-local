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
- Both units launch the **custom `server.mjs`** (not `next start`/`next dev`
  directly): it wraps Next and hosts the `/<basePath>/pty` WebSocket in the SAME
  process/port, so xterm terminals get a real PTY (see `server.mjs` +
  `server/pty.mjs`). NODE_ENV decides the mode — set on prod, unset on dev.
- **Two instances from this one working copy**, differing only by per-unit env
  (`APP_BASE_PATH` / `NEXT_PUBLIC_BASE_PATH` / `APP_DIST_DIR`, see `next.config.ts`):
  - **`admin.service`** — PROD at **`/admin`** on **:3002**: serves the
    `.next-prod` build. This is the live site. Source edits do **not** show up
    until you rebuild — ship with **`sudo admin-ctl deploy`** (builds `.next-prod`
    then restarts `admin.service`; add `--migrate` to run drizzle first).
  - **`admin-dev.service`** — on-demand DEV at **`/admin-dev`** on **:3003**:
    Next dev mode (`.next-dev` distDir) with hot-reload, for previewing changes on
    the live box before deploying. Not started at boot; control it via
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
  or `package.json`, e.g. `shop/server-app`, `shop/server-admin`; `slug=''` if the
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
  runSlug(project, app, script)` (e.g. `shop-server-app-dev`,
  `shop-server-app-lint`); tracked by a `<slug>.pid` file; `stopApp` signals the
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
- **Voice / TTS pipeline.** Spoken output (alerts, Jarvis narration, Q&A answers)
  goes through **one** entry point: `say(text, cfg, opts)` in `src/lib/tts.ts`.
  Two engines, chosen in settings (`src/store/voice.ts` — `engine: 'kokoro' |
  'browser'`, persisted to localStorage):
  · **kokoro** (default) — POST `/api/tts` (`src/app/api/tts/route.ts`) proxies to
    the **on-box Kokoro-FastAPI** container (Docker, `127.0.0.1:8880`, OpenAI-compat
    `/v1/audio/speech`; override with `KOKORO_URL`). No API key, no per-use cost,
    terminal text never leaves the box. The client decodes the MP3 and plays it
    through a shared Web Audio graph (source → **AnalyserNode** → destination);
    that analyser is handed to the orb's `reactor.setSpeakingSource()` so the
    Jarvis cloud reacts to a **real** spectrum while speaking (not the synthetic
    fallback in `jarvis-audio.ts`). A FIFO serializes utterances; `interrupt`
    clears it. If the service is down the route returns 503 and `say()` falls back
    to the browser voice — voice never hard-fails.
  · **browser** — the OS Web Speech synthesizer (`src/lib/speech.ts`).
  The Kokoro container is provisioned by `deploy/install.sh` (§11b, `INSTALL_TTS`,
  Docker `--restart unless-stopped` — no systemd unit). Curated voice list +
  picker: `KOKORO_VOICES` in `src/store/voice.ts`, `terminal-voice-controls.tsx`.
- Dashboard (`src/app/page.tsx`) and detail (`src/app/projects/[slug]/page.tsx`)
  are `dynamic = 'force-dynamic'` (they read live signals every load). `params`
  is a `Promise` — `await` it.
- **Boards (`/boards`) — real-time whiteboards** (a light FigJam: stickies, text,
  shapes, sections, connectors, pen, images, comments, dot voting, a shared timer,
  reactions, live cursors, follow mode). Two more object types: a **link** (its own card with address, title and note —
  the toolbar's Link tool asks for the address, and only http(s) is kept) and a
  **table** (first row the header; double-click a cell to type, Tab and Enter walk
  on, and the toolbar adds or drops rows and columns). Both are in the agent op
  language. Text boxes have a **Fit** that sizes the box to its words (measured from an
  offscreen copy of what's drawn, so markdown and wrapping count); a frame's title
  has its own size. Markdown on a board is sized relative to each object's own
  font size (`BOARD_TEXT`), since the shared renderer fixes its blocks at document
  sizes. Sticky / text / shape text renders as Markdown through
  `src/components/markdown.tsx` (tables, links, lists, code; no
  `dangerouslySetInnerHTML`, link schemes filtered) — editing is the raw Markdown.
  Links answer the pointer only once their object is selected, so dragging one
  about doesn't open tabs; text that is nothing but a URL draws as a link card.
  `safeMarkdown` in `boards/objects.tsx` neuters any link target that isn't
  http(s) / mailto / a path before rendering — board text is written by whoever is
  on the board and by Claude pasting from the web, so it guards at the source
  rather than trusting the renderer. A selection can also be sent straight to
  Claude as **Sum up** (one new sticky) or **Reword** (rewritten in place).
  A selected section has **Tidy** (lay its contents on a grid, in reading order,
  and size the frame to match) and **Fit** (size the frame around what it holds);
  both are pure helpers in core (`arrangeSectionOps`, `fitSectionOps`) that agents
  can call as the `arrange` / `fit` ops. Sections fold: the chevron on the title
  collapses the frame to a bar sized by its title (`sectionBarW` estimates it, so
  hit-testing needs no DOM) with a count, and what's inside drops out of sight,
  of hit-testing and of the selection (`hiddenByCollapsed`). Drawing a connector
  highlights the ends it would attach to, and dropping an end on one of the four
  dots on a shape pins the line to that side (`side` on a connector end; Unpin in
  the toolbar lets it find its own place again). Lines can be curved (`curved`),
  drawn as a bezier that always meets a shape square-on — an unpinned end takes
  the side it heads for (`autoSide`), which is what gives the curve its shape, with hit-testing and arrowheads
  following the curve; someone working outside your view shows as a marker on the edge
  of it, pointing their way — click it to follow them. Pieces:
  · `src/lib/boards/core.mjs` (+ `core.d.mts`) — the doc model and `applyOps`, plain
    JS so both the browser and the raw-Node hub import it. A board is one jsonb doc
    (`boards.doc`); edits are small ops (put/patch/del/vote/reply/meta/chat), a patch
    sets whole fields, last writer wins per field in the hub's order. Tests:
    `core.test.ts`.
  · `server/boards.mjs` — the hub, in the custom server like the PTY bridge: the
    `<basePath>/boards-ws?board=<id>` socket (cookie + Origin checked in
    `server.mjs`), one in-memory room per open board, broadcasts every batch (the
    sender's copy is its ack), relays presence, saves `doc` 1.2 s after an edit, on
    the last disconnect and on SIGTERM (an abrupt crash can lose that last second).
    Next route handlers reach it through `globalThis.__boardsHub` (same process).
  · History: the hub keeps a point you can rewind to (`board_snapshots`) every
    45 s of work and always before Claude or an agent changes anything, trimmed to
    the last 60 per board. The History panel slides over them, showing the board as
    it stood (read-only, only you see it); restoring puts everyone back and is
    itself recorded, so it can be undone. `/api/boards/<id>/history` lists them,
    `?at=<id>` returns that doc, POST restores.
  · Identity: the admin has one shared login, so each browser picks a display name
    and colour, kept in localStorage (`src/components/boards/identity.ts`).
  · Claude is a participant: asked in the board's Claude panel, `@claude` in a
    comment, or the opt-in facilitator (after 45 s of quiet, at most every 4 min,
    adds up to 3 suggestions people keep or dismiss). `server/boards-claude.mjs`
    runs the logged-in `claude` CLI (default model, admin secrets dropped from its
    env). An ask or an @mention gets the **whole CLI** — shell, files, web, plus the
    real browser from `server/boards-browser-mcp.mjs` (an MCP over `agent-browser`,
    public http(s) only, a throwaway session per run) — working from `/opt/project`
    with `--dangerously-skip-permissions`, since no one is at a keyboard to approve
    each tool. Anyone signed in already has a shell through the admin's terminals,
    so this gives a person nothing new; what it does mean is that board text, and
    any page Claude reads, reaches a prompt that can run commands. The facilitator
    gets no tools at all — nobody asked it for anything. `--strict-mcp-config` keeps
    the account's other MCP servers out. Anyone on the board can **Stop** a run: the
    hub aborts it and kills the process group plus every descendant
    (`descendantPids`), since the CLI's own shell commands sit in groups of their own. Runs stream
    (`--output-format stream-json`), so what Claude is doing — the page it opened,
    the click, its own asides — shows live on its cursor and, for a panel ask, in
    the message that becomes its reply (`describeStep`, `stepReporter`) and gets back `{ reply, ops }` in the agent op
    language (`translateAgentOps`), which the hub plays back with Claude's cursor.
  · Agents: `/api/boards` (list/create), `/api/boards/<id>` (GET doc + one JSON line
    per item, `?format=text`; PATCH title/archived; DELETE archived), `POST
    /api/boards/<id>/ops` (`{ agent, ops, chat? }`, applied live with the agent's
    cursor). Auth: the session cookie, or `x-api-key: $BOARDS_API_KEY` (proxy.ts,
    like `DIAGRAMS_API_KEY`; kept out of terminals and agent runs).
    `scripts/boards-mcp.mjs` wraps it as an MCP server (`boards_list`,
    `board_read`, `board_edit`, `board_create`); setup in its header.
  · Images: `POST /api/boards/<id>/assets` saves to `BOARD_ASSETS_DIR`
    (`/opt/project/.board-assets/<id>/`), served by `/api/boards/assets/<id>/<file>`;
    raster types only.
