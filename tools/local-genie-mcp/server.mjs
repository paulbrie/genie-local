#!/usr/bin/env node
// local-genie-mcp — a stdio MCP server that lets an assistant manage the task
// list of any project tracked by the admin dashboard (the `tasks` table in the
// `admin_dashboard` Postgres DB). Tasks are always scoped by project slug.

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

// --- DB connection --------------------------------------------------------
// Prefer DATABASE_URL from the env; otherwise read it from the admin's .env.local.
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath =
    process.env.ADMIN_ENV_FILE ?? "/opt/project/admin/.env.local";
  try {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice(line.indexOf("=") + 1).trim();
  } catch {
    /* fall through */
  }
  throw new Error("DATABASE_URL not set and not found in admin .env.local");
}

const pool = new pg.Pool({ connectionString: resolveDatabaseUrl(), max: 4 });

async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Resolve a project slug → id, or throw a clear error. */
async function projectIdBySlug(slug) {
  const rows = await q("select id from projects where slug = $1 limit 1", [
    slug,
  ]);
  if (!rows.length) throw new Error(`Unknown project: "${slug}"`);
  return rows[0].id;
}

const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

// --- MCP server -----------------------------------------------------------
const server = new McpServer({ name: "local-genie", version: "1.0.0" });

server.registerTool(
  "list_projects",
  {
    description:
      "List the projects tracked by the admin dashboard (slug + name). Use a slug to scope task operations.",
    inputSchema: {},
  },
  async () => {
    const rows = await q(
      "select slug, name, archived from projects order by slug",
    );
    return ok(rows);
  },
);

server.registerTool(
  "list_tasks",
  {
    description:
      "List a project's tasks (ordered top→bottom). Optionally filter by status.",
    inputSchema: {
      project: z.string().describe("project slug, e.g. 'my-app'"),
      status: z
        .enum(["all", "open", "done"])
        .default("all")
        .describe("which tasks to return"),
    },
  },
  async ({ project, status }) => {
    const pid = await projectIdBySlug(project);
    const where =
      status === "open"
        ? "and done = false"
        : status === "done"
          ? "and done = true"
          : "";
    const rows = await q(
      `select id, title, description, done, position, created_at, updated_at,
              (select count(*)::int from task_comments c where c.task_id = tasks.id)
                as comment_count
         from tasks where project_id = $1 ${where}
        order by position asc, created_at desc`,
      [pid],
    );
    return ok(rows);
  },
);

server.registerTool(
  "create_task",
  {
    description:
      "Create a task in a project. New tasks are added to the top of the list.",
    inputSchema: {
      project: z.string(),
      title: z.string().min(1).max(500),
      description: z.string().max(5000).optional(),
    },
  },
  async ({ project, title, description }) => {
    const pid = await projectIdBySlug(project);
    const [{ min }] = await q(
      "select coalesce(min(position), 0) as min from tasks where project_id = $1",
      [pid],
    );
    const rows = await q(
      `insert into tasks (project_id, title, description, position)
       values ($1, $2, $3, $4) returning id, title, description, done, position`,
      [pid, title.trim(), description?.trim() || null, Number(min) - 1],
    );
    return ok(rows[0]);
  },
);

server.registerTool(
  "update_task",
  {
    description: "Update a task's title and/or description.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(5000).nullable().optional(),
    },
  },
  async ({ project, id, title, description }) => {
    const pid = await projectIdBySlug(project);
    const sets = [];
    const params = [];
    if (title !== undefined) {
      params.push(title.trim());
      sets.push(`title = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description === null ? null : description.trim() || null);
      sets.push(`description = $${params.length}`);
    }
    if (!sets.length) throw new Error("Nothing to update (pass title/description)");
    params.push(id, pid);
    const rows = await q(
      `update tasks set ${sets.join(", ")}, updated_at = now()
        where id = $${params.length - 1} and project_id = $${params.length}
      returning id, title, description, done, position`,
      params,
    );
    if (!rows.length) throw new Error(`No task ${id} in project "${project}"`);
    return ok(rows[0]);
  },
);

server.registerTool(
  "set_task_status",
  {
    description: "Mark a task done or not done.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
      done: z.boolean(),
    },
  },
  async ({ project, id, done }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      `update tasks set done = $1, updated_at = now()
        where id = $2 and project_id = $3
      returning id, title, done`,
      [done, id, pid],
    );
    if (!rows.length) throw new Error(`No task ${id} in project "${project}"`);
    return ok(rows[0]);
  },
);

server.registerTool(
  "delete_task",
  {
    description: "Delete a task from a project.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
    },
  },
  async ({ project, id }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      "delete from tasks where id = $1 and project_id = $2 returning id",
      [id, pid],
    );
    if (!rows.length) throw new Error(`No task ${id} in project "${project}"`);
    return ok({ deleted: id });
  },
);

server.registerTool(
  "reorder_tasks",
  {
    description:
      "Set the manual order of a project's tasks. `orderedIds` is top→bottom; any ids omitted keep their relative order after the listed ones.",
    inputSchema: {
      project: z.string(),
      orderedIds: z.array(z.number().int().positive()).min(1),
    },
  },
  async ({ project, orderedIds }) => {
    const pid = await projectIdBySlug(project);
    const owned = new Set(
      (
        await q("select id from tasks where project_id = $1", [pid])
      ).map((r) => r.id),
    );
    let position = 0;
    for (const id of orderedIds) {
      if (!owned.has(id)) continue;
      await q(
        "update tasks set position = $1, updated_at = now() where id = $2 and project_id = $3",
        [position, id, pid],
      );
      position += 1;
    }
    const rows = await q(
      "select id, title, position from tasks where project_id = $1 order by position asc",
      [pid],
    );
    return ok(rows);
  },
);

// --- task comments (the thread under a task in the admin's Tasks tab) ------
/** Throw unless task `id` belongs to `project`; returns the project id. */
async function requireTask(project, id) {
  const pid = await projectIdBySlug(project);
  const rows = await q("select id from tasks where id = $1 and project_id = $2", [
    id,
    pid,
  ]);
  if (!rows.length) throw new Error(`No task ${id} in project "${project}"`);
  return pid;
}

server.registerTool(
  "list_task_comments",
  {
    description:
      "Read the comment thread on a task (oldest first). author is 'user' (the person in the admin UI) or 'claude'. Without `id`, returns the threads of every task in the project that has comments.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().optional().describe("task id"),
    },
  },
  async ({ project, id }) => {
    const pid =
      id === undefined ? await projectIdBySlug(project) : await requireTask(project, id);
    const rows = await q(
      `select c.id, c.task_id, t.title as task_title, c.author, c.body, c.created_at
         from task_comments c join tasks t on t.id = c.task_id
        where t.project_id = $1 ${id === undefined ? "" : "and c.task_id = $2"}
        order by c.task_id, c.created_at asc, c.id asc`,
      id === undefined ? [pid] : [pid, id],
    );
    return ok(rows);
  },
);

server.registerTool(
  "add_task_comment",
  {
    description:
      "Comment on a specific task as Claude, e.g. to answer the user, report progress or ask a question about it. Shown in the task's thread in the admin.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().describe("task id"),
      body: z.string().min(1).max(5000),
    },
  },
  async ({ project, id, body }) => {
    await requireTask(project, id);
    const rows = await q(
      `insert into task_comments (task_id, author, body) values ($1, 'claude', $2)
       returning id, task_id, author, body, created_at`,
      [id, body.trim()],
    );
    return ok(rows[0]);
  },
);

server.registerTool(
  "delete_task_comment",
  {
    description: "Delete a comment from a task's thread.",
    inputSchema: {
      project: z.string(),
      commentId: z.number().int().positive(),
    },
  },
  async ({ project, commentId }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      `delete from task_comments c using tasks t
        where c.id = $1 and c.task_id = t.id and t.project_id = $2 returning c.id`,
      [commentId, pid],
    );
    if (!rows.length) throw new Error(`No comment ${commentId} in project "${project}"`);
    return ok({ deleted: commentId });
  },
);

// --- notes (per project, same as the admin's Notes panel) -----------------
server.registerTool(
  "list_notes",
  {
    description: "List a project's notes (newest first).",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      "select id, body, position, created_at from notes where project_id = $1 order by position asc, created_at desc",
      [pid],
    );
    return ok(rows);
  },
);

server.registerTool(
  "add_note",
  {
    description: "Add a note to a project.",
    inputSchema: { project: z.string(), body: z.string().min(1).max(5000) },
  },
  async ({ project, body }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      "insert into notes (project_id, body) values ($1, $2) returning id, body, created_at",
      [pid, body.trim()],
    );
    return ok(rows[0]);
  },
);

server.registerTool(
  "update_note",
  {
    description: "Edit a note's body.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
      body: z.string().min(1).max(5000),
    },
  },
  async ({ project, id, body }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      "update notes set body = $1 where id = $2 and project_id = $3 returning id, body",
      [body.trim(), id, pid],
    );
    if (!rows.length) throw new Error(`No note ${id} in project "${project}"`);
    return ok(rows[0]);
  },
);

server.registerTool(
  "delete_note",
  {
    description: "Delete a note from a project.",
    inputSchema: { project: z.string(), id: z.number().int().positive() },
  },
  async ({ project, id }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      "delete from notes where id = $1 and project_id = $2 returning id",
      [id, pid],
    );
    if (!rows.length) throw new Error(`No note ${id} in project "${project}"`);
    return ok({ deleted: id });
  },
);

server.registerTool(
  "reorder_notes",
  {
    description: "Set the manual order of a project's notes (top→bottom).",
    inputSchema: {
      project: z.string(),
      orderedIds: z.array(z.number().int().positive()).min(1),
    },
  },
  async ({ project, orderedIds }) => {
    const pid = await projectIdBySlug(project);
    const owned = new Set(
      (await q("select id from notes where project_id = $1", [pid])).map(
        (r) => r.id,
      ),
    );
    let position = 0;
    for (const id of orderedIds) {
      if (!owned.has(id)) continue;
      await q("update notes set position = $1 where id = $2 and project_id = $3", [
        position,
        id,
        pid,
      ]);
      position += 1;
    }
    const rows = await q(
      "select id, position from notes where project_id = $1 order by position asc",
      [pid],
    );
    return ok(rows);
  },
);

// --- boot -----------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs; stdout is the MCP channel.
console.error("local-genie-mcp ready");
