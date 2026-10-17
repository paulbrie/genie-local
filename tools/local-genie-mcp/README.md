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
| `list_tasks` | `project`, `status?` (all/open/in_progress/done) | list tasks, top→bottom, with `status`, `commit_sha`, `assignee` (the terminal it was delegated to), `comment_count`, `attachment_count` |
| `create_task` | `project`, `title`, `description?` | add a task (to the top) |
| `update_task` | `project`, `id`, `title?`, `description?`, `commit?` | edit title/description/commit sha |
| `set_task_status` | `project`, `id`, `status` (open/in_progress/done), `commit?` | move between the board's columns; `done` still accepted |
| `delete_task` | `project`, `id` | remove a task |
| `reorder_tasks` | `project`, `orderedIds` | set manual order (position) |
| `list_task_comments` | `project`, `id?` | a task's comment thread (author `user`/`claude`); all threads without `id` |
| `add_task_comment` | `project`, `id`, `body` | reply on a task as Claude (shown in the admin's Tasks tab) |
| `delete_task_comment` | `project`, `commentId` | remove a comment |
| `list_task_attachments` | `project`, `id?` | files on a task, with `abs_path` to read them |
| `add_task_attachment` | `project`, `id`, `file`, `name?` | attach a local file as Claude |
| `delete_task_attachment` | `project`, `attachmentId` | remove a file |
| `list_notes` | `project` | list notes (manual order) |
| `add_note` | `project`, `body` | add a note (to the top) |
| `update_note` | `project`, `id`, `body` | edit a note |
| `delete_note` | `project`, `id` | remove a note |
| `reorder_notes` | `project`, `orderedIds` | set manual note order |

Reinstall deps if `node_modules` is missing: `cd /opt/project/tools/local-genie-mcp && npm install`.
