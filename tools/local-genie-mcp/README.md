# local-genie-mcp

A local **stdio MCP server** that lets an assistant (Claude) manage the task
list of any project tracked by the admin dashboard. It talks directly to the
`admin_dashboard` Postgres `tasks` table — the same data the admin UI's task
manager uses — so changes show up live in both places.

Registered in `/opt/project/.mcp.json` as **`local-genie`**:

```json
"local-genie": { "command": "node", "args": ["/opt/project/tools/local-genie-mcp/server.mjs"] }
```

(Claude Code loads `.mcp.json` at session start, so reload a session to pick it up.)

## Connection

Reads `DATABASE_URL` from the environment, or falls back to
`/opt/project/admin/.env.local` (override the path with `ADMIN_ENV_FILE`).

## Tools (all task ops are scoped by project `slug`)

| Tool | Args | Purpose |
| --- | --- | --- |
| `list_projects` | — | slugs + names of tracked projects |
| `list_tasks` | `project`, `status?` (all/open/done) | list tasks, top→bottom |
| `create_task` | `project`, `title`, `description?` | add a task (to the top) |
| `update_task` | `project`, `id`, `title?`, `description?` | edit title/description |
| `set_task_status` | `project`, `id`, `done` | mark done / not done |
| `delete_task` | `project`, `id` | remove a task |
| `reorder_tasks` | `project`, `orderedIds` | set manual order (position) |
| `list_notes` | `project` | list notes (manual order) |
| `add_note` | `project`, `body` | add a note (to the top) |
| `update_note` | `project`, `id`, `body` | edit a note |
| `delete_note` | `project`, `id` | remove a note |
| `reorder_notes` | `project`, `orderedIds` | set manual note order |

Reinstall deps if `node_modules` is missing: `cd /opt/project/tools/local-genie-mcp && npm install`.
