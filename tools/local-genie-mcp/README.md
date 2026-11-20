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
| `list_tasks` | `project`, `status?` (all/open/in_progress/done) | list tasks, top→bottom, with `status`, `commit_sha`, `assignee` (the terminal it was delegated to, or the agent that claimed it), `claimed_until`, `claim` (free / mine / held / done, as the caller sees it), `comment_count`, `attachment_count` |
| `create_task` | `project`, `title`, `description?` | add a task (to the top) |
| `update_task` | `project`, `id`, `title?`, `description?`, `commit?` | edit title/description/commit sha |
| `set_task_status` | `project`, `id`, `status` (open/in_progress/done), `commit?` | move between the board's columns; in_progress / done on a ticket nobody holds claims it for the calling terminal, in_progress on one another agent holds is refused; `done` still accepted |
| `claim_task` | `project`, `id?`, `as?`, `minutes?` | claim a task (or, without `id`, the next free one: open ones in board order, then in-progress ones whose agent went away) and move it to in_progress; refused, with who and until when, if another agent holds it |
| `renew_task` | `project`, `id`, `as?`, `minutes?` | restart your claim's lease |
| `release_task` | `project`, `id`, `as?` | give a claimed task back (in progress → open, nobody holds it) |
| `delete_task` | `project`, `id` | remove a task |
| `reorder_tasks` | `project`, `orderedIds` | set manual order (position) |
| `list_task_comments` | `project`, `id?` | a task's comment thread (author `user`/`claude`), each comment with its `files` (abs paths); all threads without `id` |
| `add_task_comment` | `project`, `id`, `body` | reply on a task as Claude (shown in the admin's Tasks tab) |
| `delete_task_comment` | `project`, `commentId` | remove a comment |
| `list_task_attachments` | `project`, `id?` | files on a task (`comment_id` when a comment's), with `abs_path` to read them |
| `add_task_attachment` | `project`, `id`, `file`, `name?` | attach a local file as Claude |
| `delete_task_attachment` | `project`, `attachmentId` | remove a file |
| `list_recipes` | — | saved project recipes (reusable prompts): id, name, kind, description |
| `get_recipe` | `id?` or `name?` | one recipe's full prompt |
| `save_recipe` | `name`, `body`, `kind?`, `description?` | create / update (by name) a recipe |
| `list_notes` | `project` | list notes (manual order) |
| `add_note` | `project`, `body` | add a note (to the top) |
| `update_note` | `project`, `id`, `body` | edit a note |
| `delete_note` | `project`, `id` | remove a note |
| `reorder_notes` | `project`, `orderedIds` | set manual note order |

## Claims

A task's claim is its `assignee` (`claims.mjs`, tested: `node --test tools/local-genie-mcp`). The assignee holds
it while its admin terminal is open (its tmux session `admin-<name>`: an agent there never has to renew), or until
`claimed_until`, the lease an agent outside the terminals (named with `as`) keeps renewing; past both, another agent
may claim it. Claims are taken with a conditional update (the assignee must still be the one read), so of two agents
racing for a task one gets it. The admin's Tasks tab shows a running lease on the card; delegating a task there
drops a former agent's lease.

Reinstall deps if `node_modules` is missing: `cd /opt/project/tools/local-genie-mcp && npm install`.
