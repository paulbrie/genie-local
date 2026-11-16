# Genie Local server

This is an Ubuntu 24 server where projects are developed with AI agents.
The projects are found in `/opt/project/projects`.
In `/opt/project/admin` there is a general admin interface that supervises progress in all the projects.

## Web exposure
Port 3000 is exposed under the public hostname configured at install time (`APP_PUBLIC_HOSTS`). 

## Tooling: headless browser
This server has **Playwright + headless Chromium** available for browser-based
verification — screenshotting pages, capturing console/network errors, and
driving flows like login (things `curl` can't see, e.g. client hydration or
cross-origin `_next/*` failures). Use it to confirm UI changes actually work.

- Lives in **`/opt/project/tools`** (`playwright-core` in its `node_modules`,
  persistent — not in `/tmp`). Run browser scripts from there. See its README.
  If `node_modules` is ever missing: `cd /opt/project/tools && npm install`.
- Chromium binaries persist at `~/.cache/ms-playwright/` (`chromium-*`,
  `chromium_headless_shell-*`) — survive reboots.
- Import from `playwright-core` and launch with
  `chromium.launch({ headless: true, args: ['--no-sandbox'] })`.
- For the admin app (behind auth at `.../admin`), log in via the form or set the
  `admin_session` cookie in the browser context.

## Tooling: local-genie MCP (task management)

`/opt/project/tools/local-genie-mcp` is a local **stdio MCP server**
(registered as `local-genie` in `/opt/project/.mcp.json`) for managing any
project's tasks — the same `tasks` table the admin dashboard's task manager
uses. Tools cover **tasks** (`list_tasks`, `create_task`, `update_task`,
`set_task_status`, `delete_task`, `reorder_tasks`) and **notes** (`list_notes`,
`add_note`, `update_note`, `delete_note`, `reorder_notes`), plus `list_projects`
— all scoped by project slug.
See its README. `.mcp.json` loads at session start, so reload to pick it up.

## Tooling: agent-browser (browser for agents)

**`agent-browser`** (Vercel, https://agent-browser.dev) is a Rust CLI that
drives Chrome for agents in compact text: `open <url>`, `snapshot -i` (the
accessibility tree with refs like `@e1`), `click @e1`, `fill @e2 "…"`,
`screenshot`, `close`. Prefer it to hand-written Playwright scripts for
checking a page or driving a flow; keep `tools/` for scripted checks.

- Global npm install (`/usr/lib/node_modules/agent-browser`, 0.43.0); upgrade
  with `sudo npm install -g agent-browser@latest`, then `agent-browser install`.
- Chrome for Testing lives in `~/.agent-browser/browsers/` (`agent-browser install`).
- `~/.agent-browser/config.json` sets `"args": "--no-sandbox"` (Ubuntu 24's
  AppArmor blocks Chrome's sandbox), so no `--args` is needed on the command line.
- Always pass **`--session <name>`** so agents don't share one browser; close it
  when done (`agent-browser --session <name> close`). Sessions show in the
  admin's Chrome page and Agents City.
- Guides ship with the CLI: `agent-browser skills list`, `agent-browser skills
  get core` (start there), `dogfood` (QA a web app), `modern-web-guidance` (below).
- MCP server: `agent-browser mcp` (stdio), registered user-scope as
  `agent-browser` (`claude mcp add --scope user agent-browser -- agent-browser mcp`),
  which is what `mcp__agent-browser` in `agents/*.md` refers to.
- Agent skill: `npx skills add vercel-labs/agent-browser --skill agent-browser -g -a claude-code -y`
  (a thin loader: it reads the guides from the installed CLI, so they track its version).

## Tooling: Modern Web Guidance (web platform best practices)

**Modern Web Guidance** (Chrome, Edge, Firefox and MDN teams,
https://github.com/GoogleChrome/modern-web-guidance) is installed as the Claude
Code plugin `modern-web-guidance@googlechrome` (user scope), with the skills
`modern-web-guidance` and `chrome-extensions`. Before writing UI (dialogs,
popovers, forms, layout, animation, performance), look the task up rather than
reaching for a library or a legacy pattern:

- `npx modern-web-guidance@latest search "animate a dialog"` → guide ids,
  `npx modern-web-guidance@latest retrieve "dialog"` → the guide,
  `npx modern-web-guidance@latest legacy-scan ./src` → code a guide would replace.
- Then check the built page in agent-browser:
  `agent-browser skills get modern-web-guidance`.
- The CLI sends Google anonymous usage data (agent name, guide ids, search
  queries); `DISABLE_TELEMETRY=1` turns it off.

## Tooling: UI SDK (UI behaviours)

**UI SDK** (Vercel, beta, https://github.com/vercel-labs/ui) gives keyboard
navigation, focus, selection, dismissal, popups, drag and drop and their ARIA
as primitives (`@ui-sdk/core`, with adapters `@ui-sdk/react`, `/vue`,
`/svelte`, `/solid`, `/web`). It is per project, not global: add it with
`npm install @ui-sdk/react @ui-sdk/core` when a project needs a component the
shadcn/Radix set lacks. The `ui-sdk` agent skill (user scope, via
`npx skills add vercel-labs/ui --skill ui-sdk -g`) covers composing it,
building a missing behaviour from `@ui-sdk/core`, making it usable by agents
(WebMCP) and testing keyboard, focus and ARIA.