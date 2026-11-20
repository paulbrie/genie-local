#!/usr/bin/env node
// local-genie-mcp — a stdio MCP server that lets an assistant manage the task
// list of any project tracked by the admin dashboard (the `tasks` table in the
// `admin_dashboard` Postgres DB). Tasks are always scoped by project slug.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

import { claimable, claimState, leaseMinutes, MAX_LEASE_MINUTES } from "./claims.mjs";

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

// Task attachments live on disk (same dir as the admin's TASK_ATTACHMENTS_DIR).
const ATTACHMENTS_ROOT = path.resolve(
  process.env.TASK_ATTACHMENTS_DIR ?? "/opt/project/.task-attachments",
);
const withAbsPath = (row) => ({ ...row, abs_path: path.join(ATTACHMENTS_ROOT, row.path) });
const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/plain",
  ".log": "text/plain", ".json": "application/json", ".csv": "text/csv", ".html": "text/html",
  ".svg": "image/svg+xml", ".zip": "application/zip",
};
const STATUSES = ["open", "in_progress", "done"];

/**
 * The admin terminal this MCP server runs in ("admin-Ramona" → "Ramona"), from
 * the tmux pane Claude was started in; null outside the admin's terminals.
 * Used to record who works a ticket the agent picked up by itself.
 */
let terminalName;
function myTerminal() {
  if (terminalName !== undefined) return Promise.resolve(terminalName);
  const pane = process.env.TMUX_PANE;
  if (!pane) return Promise.resolve((terminalName = null));
  return new Promise((resolve) =>
    execFile("tmux", ["display", "-p", "-t", pane, "#{session_name}"], { timeout: 3000 }, (err, out) => {
      const s = err ? "" : String(out).trim();
      resolve((terminalName = s.startsWith("admin-") ? s.slice("admin-".length) : null));
    }),
  );
}

/** The admin's terminals open now, by name (their tmux sessions, "admin-<name>"); none without a tmux server. */
function liveTerminals() {
  return new Promise((resolve) =>
    execFile("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 3000 }, (err, out) =>
      resolve(new Set(err ? [] : String(out).split("\n").filter((s) => s.startsWith("admin-")).map((s) => s.slice("admin-".length)))),
    ),
  );
}

/** Who claims: `as` when given, else this terminal; outside the admin's terminals, `as` is needed. */
async function claimer(as) {
  const me = as?.trim() || (await myTerminal());
  if (!me)
    throw new Error(
      "You're not in one of the admin's terminals: pass `as` (a name for you, shown on the task), and renew_task before the lease runs out.",
    );
  return me;
}

/** An ISO time from what pg returns (a Date), or null. */
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Who holds a task someone else has, and for how long. */
const holder = (t, live) => ({
  held_by: t.assignee,
  until: live.has(t.assignee) ? "while their terminal is open" : iso(t.claimed_until),
});

/**
 * Task `t` (as just read) for `me`, in progress, with a lease of `minutes`, if nobody took it meanwhile (its assignee
 * is still the one read): the row, or null.
 */
async function take(t, pid, me, minutes) {
  const rows = await q(
    `update tasks set assignee = $3,
            assigned_at = case when assignee is distinct from $3 then now() else assigned_at end,
            claimed_until = now() + make_interval(mins => $4::int),
            status = 'in_progress', updated_at = now()
      where id = $1 and project_id = $2 and status <> 'done' and assignee is not distinct from $5
      returning id, title, description, status, assignee, claimed_until`,
    [t.id, pid, me, minutes, t.assignee],
  );
  return rows[0] ?? null;
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
      "List a project's tasks (ordered top→bottom) with status (open / in_progress / done), commit_sha, comment/attachment counts, and `claim` as you see it: free, mine, held (another agent works on it: leave it) or done. Optionally filter by status.",
    inputSchema: {
      project: z.string().describe("project slug, e.g. 'my-app'"),
      status: z
        .enum(["all", "open", "in_progress", "done"])
        .default("all")
        .describe("which tasks to return"),
    },
  },
  async ({ project, status }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      `select id, title, description, status, commit_sha, assignee, assigned_at, claimed_until,
              position, created_at, updated_at,
              (select count(*)::int from task_comments c where c.task_id = tasks.id)
                as comment_count,
              (select count(*)::int from task_attachments a where a.task_id = tasks.id)
                as attachment_count
         from tasks where project_id = $1 and ($2 = 'all' or status = $2)
        order by position asc, created_at desc`,
      [pid, status],
    );
    const [me, live] = await Promise.all([myTerminal(), liveTerminals()]);
    return ok(rows.map((t) => ({ ...t, claim: claimState(t, me, live) })));
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
       values ($1, $2, $3, $4) returning id, title, description, status, position`,
      [pid, title.trim(), description?.trim() || null, Number(min) - 1],
    );
    return ok(rows[0]);
  },
);

server.registerTool(
  "update_task",
  {
    description: "Update a task's title, description and/or commit sha (null clears it).",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(5000).nullable().optional(),
      commit: z
        .string()
        .regex(/^[0-9a-f]{4,64}$/i)
        .nullable()
        .optional()
        .describe("commit sha that finished the task"),
    },
  },
  async ({ project, id, title, description, commit }) => {
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
    if (commit !== undefined) {
      params.push(commit === null ? null : commit.toLowerCase());
      sets.push(`commit_sha = $${params.length}`);
    }
    if (!sets.length) throw new Error("Nothing to update (pass title/description/commit)");
    params.push(id, pid);
    const rows = await q(
      `update tasks set ${sets.join(", ")}, updated_at = now()
        where id = $${params.length - 1} and project_id = $${params.length}
      returning id, title, description, status, commit_sha, position`,
      params,
    );
    if (!rows.length) throw new Error(`No task ${id} in project "${project}"`);
    return ok(rows[0]);
  },
);

server.registerTool(
  "set_task_status",
  {
    description:
      "Move a task to open / in_progress / done (shown as kanban columns in the admin). Starting one (in_progress) claims it for you, as claim_task does, and is refused when another agent holds it: never work on a task someone else holds. When finishing, set done and pass `commit` with the sha that did it. Legacy: `done: true/false` instead of `status`.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive(),
      status: z.enum(["open", "in_progress", "done"]).optional(),
      done: z.boolean().optional().describe("legacy; prefer status"),
      commit: z
        .string()
        .regex(/^[0-9a-f]{4,64}$/i)
        .optional()
        .describe("commit sha that finished the task"),
    },
  },
  async ({ project, id, status, done, commit }) => {
    const pid = await projectIdBySlug(project);
    const next = status ?? (done === undefined ? undefined : done ? "done" : "open");
    if (!next || !STATUSES.includes(next)) throw new Error("Pass status (open / in_progress / done)");
    // Working on (or finishing) a ticket nobody holds claims it for this terminal; starting one somebody else holds is
    // refused (finishing or reopening it isn't).
    const me = next === "open" ? null : await myTerminal();
    const [t] = await q("select id, status, assignee, claimed_until from tasks where id = $1 and project_id = $2", [id, pid]);
    if (!t) throw new Error(`No task ${id} in project "${project}"`);
    const live = await liveTerminals();
    const state = claimState(t, me, live);
    if (next === "in_progress" && state === "held") {
      const h = holder(t, live);
      throw new Error(`Task ${id} is ${h.held_by}'s (${live.has(t.assignee) ? h.until : `until ${h.until}`}): leave it to them, or claim_task another.`);
    }
    const taker = me && (state === "free" || state === "mine") ? me : null;
    const rows = await q(
      `update tasks set status = $1, commit_sha = coalesce($4, commit_sha), updated_at = now(),
              assigned_at = case when $5::text is not null and assignee is distinct from $5::text then now() else assigned_at end,
              assignee = coalesce($5::text, assignee),
              claimed_until = case when $1 = 'done' then null
                                   when $5::text is not null then now() + make_interval(mins => $6::int)
                                   else claimed_until end
        where id = $2 and project_id = $3 and assignee is not distinct from $7
      returning id, title, status, commit_sha, assignee, claimed_until`,
      [next, id, pid, commit?.toLowerCase() ?? null, taker, leaseMinutes(), t.assignee],
    );
    if (!rows.length) throw new Error(`Task ${id} changed hands just now: list_tasks to see who has it.`);
    return ok(rows[0]);
  },
);

const asParam = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\w .-]+$/)
  .optional()
  .describe("your name, outside the admin's terminals (a terminal is known by its own)");
const minutesParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_LEASE_MINUTES)
  .optional()
  .describe("the lease, in minutes (30 by default); a claim from an admin terminal holds while it's open anyway");

server.registerTool(
  "claim_task",
  {
    description:
      "Claim a task before working on it, so no other agent takes it too: by `id`, or without one the next free task (the open ones in the board's order, then any in progress whose agent went away; its description comes back with it). It moves to in_progress with you as its agent. It's yours while your admin terminal is open; outside the admin's terminals pass `as` and renew_task before the lease runs out. A task another agent holds is refused, with who holds it and until when: pick another. When you're done, set_task_status done; when you stop without finishing, release_task.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().optional().describe("the task; none: the next free one"),
      as: asParam,
      minutes: minutesParam,
    },
  },
  async ({ project, id, as, minutes }) => {
    const pid = await projectIdBySlug(project);
    const me = await claimer(as);
    const lease = leaseMinutes(minutes);
    const live = await liveTerminals();
    const held = (t) => ({
      held: true,
      until: live.has(me) ? "while your terminal is open" : `${iso(t.claimed_until)} (renew_task before then)`,
    });
    const rows = await q(
      `select id, title, description, status, assignee, claimed_until from tasks
        where project_id = $1 ${id ? "and id = $2" : ""} order by position asc, created_at desc`,
      id ? [pid, id] : [pid],
    );
    if (id) {
      const t = rows[0];
      if (!t) throw new Error(`No task ${id} in project "${project}"`);
      const state = claimState(t, me, live);
      if (state === "done") throw new Error(`Task ${id} is done: nothing to claim.`);
      if (state === "held") return ok({ claimed: false, task: { id: t.id, title: t.title }, ...holder(t, live) });
      const got = await take(t, pid, me, lease);
      if (got) return ok({ claimed: true, as: me, task: got, ...held(got) });
      // (someone took it between the look and the claim)
      const [now] = await q("select id, title, status, assignee, claimed_until from tasks where id = $1", [id]);
      return ok({ claimed: false, task: { id: now.id, title: now.title }, ...holder(now, live) });
    }
    for (const t of claimable(rows, me, live)) {
      const got = await take(t, pid, me, lease);
      if (got) return ok({ claimed: true, as: me, task: got, ...held(got) });
    }
    return ok({ claimed: false, reason: `no free task in "${project}"` });
  },
);

server.registerTool(
  "renew_task",
  {
    description:
      "Keep your claim on a task you're still working on: its lease starts again (30 minutes by default). Needed outside the admin's terminals, before the lease runs out; in a terminal, your claim holds while it's open anyway.",
    inputSchema: { project: z.string(), id: z.number().int().positive(), as: asParam, minutes: minutesParam },
  },
  async ({ project, id, as, minutes }) => {
    const pid = await projectIdBySlug(project);
    const me = await claimer(as);
    const rows = await q(
      `update tasks set claimed_until = now() + make_interval(mins => $4::int)
        where id = $1 and project_id = $2 and assignee = $3 and status <> 'done'
      returning id, title, status, assignee, claimed_until`,
      [id, pid, me, leaseMinutes(minutes)],
    );
    if (!rows.length) {
      const [t] = await q("select status, assignee from tasks where id = $1 and project_id = $2", [id, pid]);
      if (!t) throw new Error(`No task ${id} in project "${project}"`);
      throw new Error(t.status === "done" ? `Task ${id} is done.` : `Task ${id} isn't yours (${t.assignee ? `${t.assignee} has it` : "nobody has it: claim_task"}).`);
    }
    return ok(rows[0]);
  },
);

server.registerTool(
  "release_task",
  {
    description:
      "Give back a task you claimed and are stopping without finishing: nobody holds it any more, and if it was in progress it goes back to open, for another agent to claim. Say where you left it in a comment first (add_task_comment). Finished? set_task_status done instead.",
    inputSchema: { project: z.string(), id: z.number().int().positive(), as: asParam },
  },
  async ({ project, id, as }) => {
    const pid = await projectIdBySlug(project);
    const me = await claimer(as);
    const rows = await q(
      `update tasks set assignee = null, assigned_at = null, claimed_until = null, updated_at = now(),
              status = case when status = 'in_progress' then 'open' else status end
        where id = $1 and project_id = $2 and assignee = $3
      returning id, title, status`,
      [id, pid, me],
    );
    if (!rows.length) {
      const [t] = await q("select assignee from tasks where id = $1 and project_id = $2", [id, pid]);
      if (!t) throw new Error(`No task ${id} in project "${project}"`);
      throw new Error(`Task ${id} isn't yours to release (${t.assignee ? `${t.assignee} has it` : "nobody has it"}).`);
    }
    return ok({ released: true, ...rows[0] });
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
    await fsp.rm(path.join(ATTACHMENTS_ROOT, String(id)), { recursive: true, force: true });
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
        "update tasks set position = $1 where id = $2 and project_id = $3",
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
      "Read the comment thread on a task (oldest first). author is 'user' (the person in the admin UI) or 'claude'. Each comment lists the files that came with it (`files`: name, mime, size, abs_path: open screenshots to look at them). Without `id`, returns the threads of every task in the project that has comments.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().optional().describe("task id"),
    },
  },
  async ({ project, id }) => {
    const pid =
      id === undefined ? await projectIdBySlug(project) : await requireTask(project, id);
    const rows = await q(
      `select c.id, c.task_id, t.title as task_title, c.author, c.body, c.created_at,
              coalesce((select json_agg(json_build_object('id', a.id, 'name', a.name, 'mime', a.mime,
                                                          'size', a.size, 'path', a.path) order by a.id)
                          from task_attachments a where a.comment_id = c.id), '[]') as files
         from task_comments c join tasks t on t.id = c.task_id
        where t.project_id = $1 ${id === undefined ? "" : "and c.task_id = $2"}
        order by c.task_id, c.created_at asc, c.id asc`,
      id === undefined ? [pid] : [pid, id],
    );
    return ok(rows.map((r) => ({ ...r, files: r.files.map(withAbsPath) })));
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

// --- task attachments (files uploaded / pasted into a ticket in the admin) --
server.registerTool(
  "list_task_attachments",
  {
    description:
      "List the files attached to a task (or to every task of the project without `id`). `abs_path` is readable directly, e.g. to look at a pasted screenshot.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().optional().describe("task id"),
    },
  },
  async ({ project, id }) => {
    const pid =
      id === undefined ? await projectIdBySlug(project) : await requireTask(project, id);
    const rows = await q(
      `select a.id, a.task_id, a.comment_id, t.title as task_title, a.name, a.mime, a.size, a.path,
              a.author, a.created_at
         from task_attachments a join tasks t on t.id = a.task_id
        where t.project_id = $1 ${id === undefined ? "" : "and a.task_id = $2"}
        order by a.task_id, a.created_at asc, a.id asc`,
      id === undefined ? [pid] : [pid, id],
    );
    return ok(rows.map(withAbsPath));
  },
);

server.registerTool(
  "add_task_attachment",
  {
    description:
      "Attach a local file (e.g. a screenshot you took) to a task as Claude. The file is copied into the attachments store.",
    inputSchema: {
      project: z.string(),
      id: z.number().int().positive().describe("task id"),
      file: z.string().describe("absolute path of the file to attach"),
      name: z.string().max(120).optional().describe("display name (default: the file's name)"),
    },
  },
  async ({ project, id, file, name }) => {
    await requireTask(project, id);
    const src = path.resolve(file);
    const stat = await fsp.stat(src);
    if (!stat.isFile()) throw new Error(`${src} is not a file`);
    if (stat.size > 50 * 1024 * 1024) throw new Error(`${src} is over 50 MB`);
    const safe = path.basename(name ?? src).replace(/[^\w.\- ]+/g, "_").trim().slice(-120) || "file";
    const rel = path.join(String(id), `${randomBytes(4).toString("hex")}-${safe}`);
    await fsp.mkdir(path.join(ATTACHMENTS_ROOT, String(id)), { recursive: true });
    await fsp.copyFile(src, path.join(ATTACHMENTS_ROOT, rel));
    const mime = MIME_BY_EXT[path.extname(safe).toLowerCase()] ?? "application/octet-stream";
    const rows = await q(
      `insert into task_attachments (task_id, name, mime, size, path, author)
       values ($1, $2, $3, $4, $5, 'claude')
       returning id, task_id, name, mime, size, path, author, created_at`,
      [id, safe, mime, stat.size, rel],
    );
    return ok(withAbsPath(rows[0]));
  },
);

server.registerTool(
  "delete_task_attachment",
  {
    description: "Remove a file from a task.",
    inputSchema: { project: z.string(), attachmentId: z.number().int().positive() },
  },
  async ({ project, attachmentId }) => {
    const pid = await projectIdBySlug(project);
    const rows = await q(
      `delete from task_attachments a using tasks t
        where a.id = $1 and a.task_id = t.id and t.project_id = $2 returning a.path`,
      [attachmentId, pid],
    );
    if (!rows.length) throw new Error(`No attachment ${attachmentId} in project "${project}"`);
    await fsp.rm(path.join(ATTACHMENTS_ROOT, rows[0].path), { force: true });
    return ok({ deleted: attachmentId });
  },
);

// --- project recipes (the admin's Recipes page: reusable project prompts) --
server.registerTool(
  "list_recipes",
  {
    description:
      "List the saved project recipes (reusable prompts for kinds of projects): id, name, kind, one-line description. Use get_recipe for the prompt itself.",
    inputSchema: {},
  },
  async () =>
    ok(
      await q(
        "select id, name, kind, description, updated_at from project_recipes order by kind nulls last, name",
      ),
    ),
);

server.registerTool(
  "get_recipe",
  {
    description:
      "Read one project recipe's full prompt, by id or by name (case-insensitive). Follow it to start or extend a project.",
    inputSchema: {
      id: z.number().int().positive().optional(),
      name: z.string().min(1).optional(),
    },
  },
  async ({ id, name }) => {
    if (id === undefined && !name) throw new Error("Pass id or name");
    const rows =
      id !== undefined
        ? await q("select * from project_recipes where id = $1", [id])
        : await q("select * from project_recipes where lower(name) = lower($1)", [name]);
    if (!rows.length) throw new Error(`No recipe ${id ?? `"${name}"`} (see list_recipes)`);
    return ok(rows[0]);
  },
);

server.registerTool(
  "save_recipe",
  {
    description:
      "Save a project recipe (create, or update the one with the same name): a reusable prompt for a kind of project, shown in the admin's Recipes page.",
    inputSchema: {
      name: z.string().min(1).max(120),
      body: z.string().min(1).max(100000).describe("the prompt (markdown)"),
      kind: z.string().max(80).optional().describe("project type, e.g. 'Web app'"),
      description: z.string().max(300).optional().describe("one line: when to use it"),
    },
  },
  async ({ name, body, kind, description }) => {
    const rows = await q(
      `insert into project_recipes (name, body, kind, description) values ($1, $2, $3, $4)
       on conflict (name) do update set body = excluded.body,
         kind = coalesce(excluded.kind, project_recipes.kind),
         description = coalesce(excluded.description, project_recipes.description),
         updated_at = now()
       returning id, name, kind, description, updated_at`,
      [name.trim(), body.trim(), kind?.trim() || null, description?.trim() || null],
    );
    return ok(rows[0]);
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
