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
- **Sign in with Genie** (Google, brokered by the genie manager; no keys on the box).
  `/api/auth/genie/start` → the manager's `/auth/vps/start` → Google → the manager
  POSTs a short-lived EdDSA assertion to `/api/auth/genie/callback`, verified here
  against the manager's JWKS (iss/aud/project/nonce cookie/exp/jti replay in
  `admin_sso_jtis`; `src/lib/genie-sso-core.ts`). The server's identity comes from
  `/opt/project/.genie-instance.json` (written by genie). The person must be a member
  of the server's genie project (genie checks) AND an enabled row in Settings → Users
  (`admin_users`); the session is then `sub: "user:<email>"`. `verifySessionToken`
  re-checks that row (cached 10 s, `src/lib/session-access.mjs`, shared with
  `server/pty.mjs`), so disabling or removing someone ends their sessions too; open
  terminal/board sockets are re-checked every 30 s in server.mjs. The shared
  `ADMIN_USER`/`ADMIN_PASSWORD` login (`sub: "admin"`) stays as the emergency login.
  The proxy lets exactly `POST /api/auth/genie/callback` skip its origin check
  (`src/lib/proxy-rules.ts`).
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

- **Updating from GitHub.** The toolbar shows a button only when `origin` is ahead
  of this checkout (`src/lib/admin-update.ts`, polled every 3 min via
  `/api/admin-update`). It fast-forwards, reinstalls if `admin/package-lock.json`
  moved (with NODE_ENV dropped, or npm skips the dev packages the build needs),
  then runs the same `admin-ctl deploy --migrate` the Services page uses. Nothing
  is forced: local commits or uncommitted edits block it with a message instead of
  being overwritten. `ADMIN_REPO` overrides the repo path, which is how the git
  half gets tested without touching the real one.
  Commits made in this checkout and pushed never put `origin` ahead, so the button
  also shows ("Deploy N commits") when `admin/` has commits newer than the running
  build: `next.config.ts` bakes the commit a production build is made from into
  `ADMIN_BUILT_COMMIT`, and the click only runs `admin-ctl deploy --migrate`.

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
  running `dev`. Runs as `genie`, no sudo. **The child env is an allowlist**
  (`cleanEnv` in `src/lib/clean-env.mjs`, shared with the terminals): PATH, HOME,
  USER, the locale, `PUBLIC_HOST`, plus `PORT` from the DB — never a copy of the
  admin's. Its NODE_ENV=production, basePath, `next dev`'s TURBOPACK=1 and its
  `.env.local` (DATABASE_URL, tokens) used to leak in and win over the app's own
  `.env` (Next never overrides a variable that's already set). The tmux server
  behind every terminal gets the same allowlist, and since it keeps the env it
  started with, `terminals.ts` unsets an admin's variables from its global env
  once per admin process (`staleTmuxEnvKeys`). **How it runs is
  per app** (`apps.run_*`, the app card's Runs row, `src/lib/run-isolation.ts`,
  pure and tested): on the box, in a systemd user scope per run
  (`systemd-run --user --scope`, `spiridus-<slug>-<id>.scope`, named in
  `<slug>.unit`; needs `loginctl enable-linger genie`, install.sh does it), so
  `MemoryMax` / `CPUQuota` hold for everything it starts and Stop kills the
  whole scope, strays in their own session included; or **in Docker**
  (`docker run --rm --init --network=host --user genie`, the project mounted at
  its own path, `node:<major>-trixie-slim` unless the app names an image; the
  major from `.nvmrc` / `.node-version`, else the host's; trixie's glibc is
  newer than the host's, so host-built native modules load). The container's id
  is in `<slug>.cid`: Stop `docker stop`s it, and its memory comes from its
  cgroup (`containerMemBytes`; the pid is the `docker run` client's). With no
  user manager it runs as before, caps not applied. `admin.service` still sets
  **`KillMode=process`** so restarting admin does NOT kill project servers that
  live in its cgroup (that fallback). UI: `src/components/script-row.tsx` renders one
  Run/Stop/Restart + status dot + `/logs?file=…` deep-link **per script** in the
  detail page's Scripts list (`actions.ts` validates the script exists in the
  app's package.json). The **dashboard cards** show live running state: they poll
  `GET /api/run-status` (alive run-slugs) and match via `src/lib/run-slug.ts` —
  a pure `runSlug()`/`isAppServerRunning()` shared by server and client. An app
  reads as "running" on the dashboard when its `dev` or `start` unit is alive.
  Keep runner + run-slug in sync.
- `src/store/ui.ts` — `subjecto` `Subject`s for **UI state only** (search, view
  mode). Server data stays in RSC/DB; use `useSubject` from `subjecto/react`.
- **Two interfaces: classic and desktop** (the top bar's switch, `ShellSwitch`). The choice is the
  `admin_shell` cookie (path = basePath, so /admin and /admin-dev keep their own), read by the root
  layout, so the server already renders the right one. `src/components/desktop/app-shell.tsx` puts the
  page at the same place in the tree in both (`Workspace`, whose wrappers are `display: contents` in
  classic), so switching never remounts it; in desktop the shell is a grid (the top bar the whole
  width, the sidebar under it at the left, the content area beside it), its inner column `contents`
  too. Desktop (`desktop.tsx`): the page inline, as in classic (the content area scrolls it, no frame
  around it), the classic sidebar (`AppSidebar`, always there, see below), the Spiridus menu at the
  bar's left, and Home ("/", the sidebar's House item): a wallpaper with its widgets in the page's
  place (no icons, no Launchpad: the sidebar and ⌘K reach every app and project). Beside the page's
  name in the top bar, a detach icon (`PictureInPicture2`, desktop-menu.tsx; there so it never
  covers a page's own controls) pops the page out: a pop-up window over the content area (drag,
  resize from any edge, maximize, minimize, close; its title bar has the app's tile, `app-icon.tsx`,
  and an icon that puts it back inline, in place of the page there), and the page area goes back to
  Home. A pop-up is a frame (see "More windows"), so the page loads afresh in it, and again when put
  back: the URL is always the page inline. "Open in a new window" makes more. The
  sidebar is one in both interfaces: Settings → General → Sidebar → Items picks what it shows
  (`desk.hiddenNav`, `setNavShown`; `navShown` / `NAV_ALWAYS` in lib/desktop.ts: the home and
  Settings always show, so there's a way back; a group's items go with it), and an item's
  right-click has "Hide from sidebar" (classic: `NavMenu`; desktop: `DeskNavLink`'s menu). Hiding
  one closes no window. The sidebar reads `desk` itself (`loadDesk`), so classic has it too (it
  shows everything until that's read, a moment after load). In the desktop the sidebar's first item
  is Home instead of Dashboard (`NavItem.desktop`; the top bar's title, ⌘K, Settings and the
  Spiridus menu's "Show Home" say Home too; the interface itself is still "Desktop"), and
  `src/app/page.tsx` skips the Dashboard's metrics when the cookie says desktop (switching to
  classic there refreshes it). Its state is `src/store/desktop.ts`; the pure parts are tested
  (`src/lib/desktop.ts`: the pop-ups' places, `defaultGeom` / `popupStart` / `maxRect`, what a tab
  remembers of them, `parsePopups`, `pathUnder`, `frontmost`). The page inline has no z-index, as
  in classic; each pop-up is a layer at its place in `stack` (`winZ`).
  · The widgets sit on a grid (`GRID`, `gridSize`: 92 × 96 px cells, the icons' that were, so saved
    spans hold), drawn as one arrangement against the left, centred or against the right
    (`desk.align`, `alignShift`); there a drop can land left of column 0, and the whole moves over to
    stay on the grid (`dropRange` / `fitShift`), so nothing else moves on screen. Old `desk.icons` /
    `desk.removedIcons` are dropped when read (`parseDesk`).
  · Drags (a widget's move or resize) also end when the window loses the pointer or the
    focus mid-drag (`lostpointercapture`, `blur`), which sends no pointerup: they go back, rather
    than stay drawn half-way with their drop target.
  · The sidebar in desktop (no dock): classic's, under the top bar, VS Code where classic has it;
    classic's own black-and-white icons, sized by Settings' Sidebar → Size (`desk.sidebarSize`,
    `SIDEBAR_ICON` 16–40 px rows, 24 = classic's 15 px glyph, `sideGlyph`; an old `dockSize` carries
    over halved; `sidebarWidth`: classic's widths at the default), the rail collapse in its footer.
    No swell under the pointer (there was one, the dock's; it brought nothing). Lit is the page
    inline (Home at "/"), as in classic; a dot marks an app popped out. A click (`DeskNavLink`,
    through Link's `onNavigate`, so a modifier-click is a new tab) shows the page inline, unless the
    app is popped out: then its window comes to the front, un-minimized (`raiseApp`). Projects and
    boards under their items, widget rows (`useOpenPath` / `useOpenApp`), Settings and ⌘K do the
    same (`raisePath`). Right-click: open, in a new window (not on a phone) or tab, close its
    windows, hide from the sidebar. "Show Home" (Spiridus menu) goes Home and minimizes every
    pop-up (`minimizeAll`). On a phone it's classic's drawer (the top bar's menu button), the
    Spiridus menu (and so the detach icon) from `md` up, no new windows, and the widgets go one a
    row. Pop-ups and the widgets have the whole content area: nothing is kept clear.
  · Settings (`/settings`, in `NAV`): panes listed in `SETTINGS_PANES` (also in ⌘K). General
    (`settings-panel.tsx`): interface, theme, the sidebar's items and size, and Home's widgets and
    their arrangement. Users (`/settings/users`; `/users` redirects there): who may Sign in with
    Genie. It reads `desk` itself (`loadDesk`), so it works from classic too; `loadDesk` follows
    `storage` events, so a change made in a pop-up's frame (a separate document) reaches the desktop
    around it.
  · Widgets (registry: `widget-registry.tsx`, `WIDGET_BODY` / `WIDGET_ICON`; `WIDGETS` /
    `WIDGET_LABEL` / `WIDGETS_OFF` / `WIDGET_APP` in lib/desktop.ts; shared parts in `widget-parts.tsx`:
    `WidgetHeader`, `usePolled`, `useOpenPath` / `useOpenApp`, `useWidgetView` + `ViewSwitch` for a
    widget's own remembered choices, `desk.widgets[id].views`; framed by `WidgetFrame` in desktop.tsx).
    On at first: Terminals, Projects (`status-widget.tsx`); Disk (`disk-widget.tsx`: /opt/project,
    /tmp, the home folder, /usr, /var with their largest entries, Docker from `docker system df`, and
    the rest as Other; as a list, a bar, a donut or a squarified treemap, `src/lib/treemap.ts`; /api/disk,
    `disk-overview.ts`, du at `nice` in the background at most every 10 min; in every view a click on
    a folder (a row, a segment, an arc, a tile) drills into it, a breadcrumb back up, switching views
    staying there: /api/disk/dir, du two levels deep, within the Files
    explorer's roots, kept 5 min); Memory
    (`memory-widget.tsx`: now, the RAM as one segmented bar by project, agents striped, or by
    terminal; or over 24 h / 7 / 30 days (30 by default), a stacked area from the per-minute history,
    /api/widgets/memory, `memory-history-core.ts`); Processes (the busiest by CPU or memory, named by
    port); Docker (containers with their CPU and memory, `docker stats` cached 15 s, and the images).
    Off at first (`more-widgets.tsx`, data in `src/lib/widgets.ts` via /api/widgets/<id>, pure parts in
    `widgets-core.ts`): Health, Production errors, Git, Load (CPU and memory over the last hour, 24 h,
    7 or 30 days, 30 by default, from the stats history's `1h`…`30d`; the network now), Tickets (in progress, to do, recently
    done), Sign-ins. A row opens the page behind it (inline, or its pop-up to the front:
    `raisePath`); a widget with an app has the
    app's icon in its header. Fold and hide show on hover (always on a device that can't hover). A
    right-click on the wallpaper (`DeskMenu`) lists every widget: one added goes under the pointer.
    Folded, a widget is one grid row tall, a glance. A window shorter than the arrangement doesn't
    squeeze it: the grid keeps the rows it needs and the desktop scrolls (a widget with no free spot
    on the grid goes under the others, `placeWidgets`, never on one). Only the width stacks the desktop:
    when the widgets put by hand, from the first's left edge to the last's right edge, are wider than
    it (`arrangementFits`; a default spot only counts when it has no room at all), the widgets go one
    a row the whole width (`stackDesktop`; always on a phone), nothing dragged until there's room
    again. Narrower but still wide enough, they move over together (`fitShift`) to stay as they are.
  · More windows: every pop-up is a page in a frame (`FrameWindows`, `stack` / `frames` in the store,
    sessionStorage per tab, so a reload brings them back, minimized or not; read with `parsePopups`).
    A new one opens where its app's last one was (`desk.geoms`, `popupStart`; the default centred,
    smaller than the area), a step further for each one open, and keeps its own place after.
    A request with `Sec-Fetch-Dest: iframe` renders the page alone (the root layout's `embedded`:
    `FramedPage` in app-shell.tsx, none of the shell, nor what runs once per tab: terminal dock,
    voice, alerts, activity). The framed page posts its path, clicks, ⌘K and the terminals it opens
    to the page around it (`openTerminalsIn`).
- **⌘K / Ctrl+K: the command palette** (`src/components/command-palette.tsx`, search in
  `src/lib/command-search.ts`): pages, projects and their tabs, terminals, a few actions, in both
  interfaces. Code editors keep their own ⌘K / Ctrl+K, and a terminal its Ctrl+K.
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
- **Slack bot** (`src/lib/slack/`, docs in `docs/slack.md`). Runs in the prod
  process only, started by `src/instrumentation.ts` (`SLACK_ON_DEV=1` runs it on
  dev). It uses Socket Mode over `ws` with `fetch` for the Web API, no Slack SDK
  (`socket.ts`). `core.ts` is pure and tested: commands, the 2-poll alert
  detection, pane excerpts, choice buttons. `bot.ts` wires it to terminals.ts,
  data.ts and `askAboutTerminals` (`src/lib/terminal-qa.ts`, shared with
  `/api/ask`). It only answers `SLACK_ALLOWED_USERS`. `SLACK_BOT_TOKEN` and
  `SLACK_APP_TOKEN` are in every SECRET_ENV list, so keep them there when
  adding one.
- Dashboard (`src/app/page.tsx`) and detail (`src/app/projects/[slug]/page.tsx`)
  are `dynamic = 'force-dynamic'` (they read live signals every load). `params`
  is a `Promise` — `await` it.
- **GitHub remote per repo** (a project's Git tab → Remote). The URL (`owner/repo`, ssh or https,
  normalized to https, credentials stripped) becomes the repo's `origin`; the personal access token
  is stored AES-GCM in `git_credentials` (per project + repo, `src/lib/git-auth.ts`) and never sent
  back. Push, Commit & push and Refresh hand it to git as an auth header for that host only, through
  `GIT_CONFIG_COUNT/KEY/VALUE` in the environment (`gitRemoteEnv`), never in `.git/config`, the URL
  or argv. Saving checks it with `git ls-remote`. `APP_ENC_KEY` may be hex or base64 (crypto.ts).
- **Review before push** (a project's Git tab). Per project: branches (globs), whose pushes
  (agents = shells with `CLAUDECODE` set, people, both), block-at severity, effort, skipped files,
  timeout. Saved to `/opt/project/.review/config.json` (by repo; `REVIEW_DIR` overrides) and a
  `pre-push` hook is installed in each of the project's repos (a repo's own hook is kept as
  `pre-push.genie-chained` and runs first; a repo with `core.hooksPath`, e.g. husky, gets the line
  to add by hand). The hook runs `scripts/review-hook.mjs`: `claude -p` with read-only tools and a
  JSON schema reviews the pushed range, findings at or above the setting stop the push, results go
  to `.review/results/` (shown on the Git tab). It fails open (busy, timeout, no Claude);
  `REVIEW=skip git push` overrides and is logged. Decisions: `src/lib/code-review/core.mjs` (tested).
- **DB Explorer (`/db`) finds this box's databases itself** (`src/lib/db-discovery.ts`, pure parts
  in `db-discovery-core.ts`, tested): the admin's own `DATABASE_URL`, every local postgres:// / mysql://
  URL in the projects' and their apps' `.env*` files (remote hosts left out), and the running database
  containers (the user, password and database their image's env sets up, at the port they publish).
  One connection per server and user (`connKey`), so admin_app on :5432 is one for every database it
  owns. Listing the connections looks (at most every 30 s) and syncs them into `connections` rows with
  an `auto_key`: kept up to date from their source, not editable by hand (409), removed when their
  source goes unless they have saved queries; one the same as a connection added by hand is left to
  that one. A port nothing answers on shows as "not running".
- **Boards (`/boards`) — real-time whiteboards** (a light FigJam: stickies, text,
  shapes, sections, connectors, pen, images, comments, dot voting, a shared timer,
  reactions, live cursors, follow mode). Two more object types: a **link** (its own card with address, title and note —
  the toolbar's Link tool asks for the address, and only http(s) is kept) and a
  **table** (first row the header; double-click a cell to type, Tab and Enter walk
  on, rows share the height evenly, and the toolbar adds, drops or shifts rows
  and columns around the cell you last clicked). Both are in the agent op
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
  highlights the ends it would attach to. Dropping an end near a shape's border
  pins it to that exact spot (`at`, a 0..1 position on the box); dropping it well
  inside leaves it free to pick its own side as things move, which Unpin also
  restores. Lines **curve by default** (`straight` records the exception), leaving
  and arriving square-on, and dragging the handle at a curve's middle bows it
  through that point (`bend`, held relative to the two ends). Ends meet an object's **visible** box
  (`visualRect`), so folding a section leaves the lines on it joined to the bar it
  became. `connectorCurve` in geometry.ts is the single source for the path, the points it's hit-tested and
  bounded by, and the way the arrowheads face, with hit-testing and arrowheads
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
    `board_read`, `board_edit`, `board_history`, `board_create`), registered for
    this box in `/opt/project/.mcp.json` (gitignored). It reads `BOARDS_API_KEY`
    from the admin's own `.env.local`, so the key isn't copied into a second file;
    with no key — or against an admin started before one was added, which knows
    nothing of it and answers 401 — it signs in with `ADMIN_USER` /
    `ADMIN_PASSWORD` instead and uses that session, so it needs no restart.
  · Images: `POST /api/boards/<id>/assets` saves to `BOARD_ASSETS_DIR`
    (`/opt/project/.board-assets/<id>/`), served by `/api/boards/assets/<id>/<file>`;
    raster types only.
- **Browsers (`/browsers`) — people's own Chrome, driven from here** through the
  Spiridus Bridge extension (`extension/`, Manifest V3, no build step).
  · Pairing: "Pair a browser" makes a single-use code (10 min, in memory); the
    person types it into the extension's popup. The extension's service worker
    opens `<basePath>/browser-ws` and claims it; the hub (`server/browser-bridge.mjs`,
    in server.mjs like boards) stores a `browser_links` row with only the token's
    SHA-256 and hands the token back. It says hello with that token on every
    reconnect. The socket's Origin is `chrome-extension://…` and has no cookie, so
    server.mjs routes it with no Origin/cookie check: the code or token is its
    whole auth (wrong codes are throttled per X-Real-IP). Unpairing (here, or the
    popup) sets `revoked_at` and drops the socket. A DB error answers 1011, never
    4401: 4401 makes the extension forget its token.
  · Control: only tabs the person shared from the popup (or "Share every tab"),
    plus tabs Spiridus opened itself. Everything goes through `chrome.debugger`
    (real mouse/key events, Runtime.evaluate, Page.captureScreenshot, raw CDP), so
    Chrome shows its "being debugged" bar; cancelling it unshares the tab. The
    command list is at the top of `extension/background.js`.
  · Agents: `/api/browsers` (list, with live tabs), `POST /api/browsers/pair-code`,
    `PATCH|DELETE /api/browsers/<id>` (rename / unpair), `POST
    /api/browsers/<id>/command` (`{ type, args, timeoutMs? }` → `{ ok, data|error }`),
    `GET /api/browsers/<id>/events?after=&wait=` (console, errors, navigations,
    dialogs). Auth: the session cookie, or `x-api-key: $BROWSERS_API_KEY`.
    `scripts/browsers-mcp.mjs` wraps it as an MCP server (`browsers_list`,
    `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`,
    `browser_eval`, `browser_cdp`, …), credentials as for boards-mcp.
  · In the page (`extension/overlay.js`, a content script in a closed shadow root): in shared tabs, the actor's cursor
    gliding to what it clicks/types/scrolls with "<by> · <what>", a pill with the last action, a glow and a "… is
    working here" badge (background.js `show()`; commands take `by`, which browsers-mcp sets to its terminal's name).
    And, while paired, a chat bubble: talk to any Spiridus terminal (typed and submitted; Claude terminals through
    `sendBrief`), see its screen live (`paneExcerpt`, as the Slack bot), answer its choices, or start a new talk
    (`startAgent`, in a project). "Include this page" adds the tab, URL and browser id to the message. Its calls go
    through the background to `/api/browsers/ext/{terminals,screen,talk,key}`, which take the pairing token
    (`Authorization: Bearer`, `src/lib/browsers/ext.ts`) instead of a session: proxy-rules.ts lets that prefix past
    the session and origin checks. The overlay ignores untrusted (page-made) events.
  · **Computers** (Spiridus Desktop, `desktop/`, see its README): a Tauri app for macOS/Windows on the same hub.
    Its claim says `kind: "desktop"` (`browser_links.kind`), it reports `{t:"state"}` (displays, OS, user, what
    its owner allows, paused), and takes its own commands (screenshot per display, click/type/key/scroll/drag in
    display points, ui_tree, apps/open/focus, clipboard, run, ls/read/write). The Browsers page shows a desktop
    panel (`desktop-control.tsx`); browsers-mcp has `desktop_*` tools; its chat window uses the ext routes with
    `computer: true`. Builds: `.github/workflows/desktop.yml` → the `desktop-latest` pre-release.
  · `GET /api/browsers/extension` zips `extension/` with `config.js` rewritten to
    the address it was downloaded from; people install it with Load unpacked.
    Editing the extension means a re-download (or a reload of the unpacked folder).
