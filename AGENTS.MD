# Influentech Development server

This is an Ubuntu 24 server in which Influentech runs its projects with AI.
The projects are found in `/opt/project/projects`.
In `/opt/project/admin` we have a general admin interface that supervises progres in all the projects.

## Web exposure
Port 3000 is exposed under https://ft.cloud.teleporthq.ai. 

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