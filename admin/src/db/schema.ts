import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * One row per top-level project directory under PROJECTS_ROOT.
 * A project is a container that holds one or more apps (sub-projects).
 * `slug` is the directory name and the stable external identifier.
 */
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    name: text("name"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("projects_slug_uq").on(t.slug)],
);

/**
 * An app (sub-project) inside a project: an immediate subdirectory that has a
 * `.git` and/or `package.json` (e.g. shop/server-app, shop/server-admin). When a
 * project directory is itself an app, a single app with `slug = ''` is used.
 */
export const apps = pgTable(
  "apps",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(), // dir name relative to the project; '' = root app
    path: text("path").notNull(),
    name: text("name"),
    isGit: boolean("is_git").notNull().default(false),
    // Local port this app's live server listens on; drives Nginx routing for
    // /projects/<project>/<app>/. Null = not routed yet.
    port: integer("port"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("apps_project_slug_uq").on(t.projectId, t.slug)],
);

/**
 * Point-in-time capture of one app's live signals. Rows accumulate so the
 * dashboard can show history/trends per app.
 */
export const statusSnapshots = pgTable("status_snapshots", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  gitBranch: text("git_branch"),
  gitDirty: boolean("git_dirty"),
  ahead: integer("ahead"),
  behind: integer("behind"),
  lastCommitAt: timestamp("last_commit_at", { withTimezone: true }),
  lastCommitHash: text("last_commit_hash"),
  dirMtime: timestamp("dir_mtime", { withTimezone: true }),
  // bigint (mode: number): a project dir can exceed 2^31 bytes (~2.15 GB) — with
  // node_modules etc. — which overflows int4 and fails the snapshot insert.
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  // Full app signal blob (package.json scripts, file presence flags, errors…)
  raw: jsonb("raw"),
});

/** Notes are attached to the project as a whole (not individual apps). */
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  // Manual sort order within a project (smaller = higher in the list).
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Tasks are attached to the project as a whole (not individual apps). */
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  // 'open' | 'in_progress' | 'done' (TASK_STATUSES). The source of truth; a DB
  // trigger (migration 0010) keeps `done` in step for older writers.
  status: text("status").notNull().default("open"),
  done: boolean("done").notNull().default(false),
  // The commit that finished the task (for done tasks).
  commitSha: text("commit_sha"),
  // The terminal (Claude session, by its admin name) the task was delegated to.
  assignee: text("assignee"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  // Manual sort order within a project (smaller = higher in the list).
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const TASK_STATUSES = ["open", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A file attached to a task (uploaded or pasted in the admin, or attached by
 * Claude through the MCP). The bytes live on disk under TASK_ATTACHMENTS_DIR at
 * `path` (relative), so agents can read them directly.
 */
export const taskAttachments = pgTable("task_attachments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  path: text("path").notNull(),
  author: text("author").notNull().default("user"),
  // Set when the file came with a comment (shown under it in the thread); null = the ticket's own files.
  commentId: integer("comment_id").references(() => taskComments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A comment thread on a task, so the user and Claude (via the local-genie MCP
 * `add_task_comment` tool) can talk about one specific task.
 */
export const taskComments = pgTable("task_comments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  // 'user' (written in the admin UI) | 'claude' (written through the MCP).
  author: text("author").notNull().default("user"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Every admin login attempt and logout: who tried (IP, browser, the username
 * typed; never the password), and for a failure, why.
 */
export const adminLogins = pgTable("admin_logins", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  // 'login' | 'logout'
  event: text("event").notNull().default("login"),
  ok: boolean("ok").notNull(),
  // For a failed login (LOGIN_FAILURES): 'wrong_password' | 'unknown_user' | …
  reason: text("reason"),
  username: text("username"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  // The session this login opened / this logout ended (admin_sessions.id).
  sessionId: text("session_id"),
});

/**
 * Admin sessions, keyed by a hash of the session cookie (the cookie itself is
 * a stateless signed token). The top bar's heartbeat keeps last_seen_at fresh
 * while a tab is open: seen in the last minute = connected.
 */
export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  // 'login' (the login form) | 'token' (a cookie first seen elsewhere, e.g. `npm run session`)
  via: text("via").notNull().default("login"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

/**
 * A project recipe: a reusable prompt for starting (or extending) a kind of
 * project, e.g. "Next.js + Drizzle admin app". Saved in the admin's Recipes
 * page; agents read them through the local-genie MCP (list_recipes / get_recipe).
 */
export const projectRecipes = pgTable(
  "project_recipes",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    // What kind of project it makes, for grouping (e.g. "Next.js app").
    kind: text("kind"),
    // One line: when to use it.
    description: text("description"),
    // The prompt itself (markdown).
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_recipes_name_key").on(t.name)],
);

/** A saved database connection for the DB explorer. Password is encrypted. */
export const connections = pgTable("connections", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  engine: text("engine").notNull(), // 'postgres' | 'mysql'
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  passwordEnc: text("password_enc"), // AES-GCM ciphertext (nullable = no password)
  defaultDatabase: text("default_database"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A saved SQL query, scoped to a connection + database name. */
export const savedQueries = pgTable("saved_queries", {
  id: serial("id").primaryKey(),
  connectionId: integer("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  database: text("database").notNull(),
  name: text("name").notNull(),
  sql: text("sql").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A saved diagram authored as plain-text source (Mermaid by default). Kept as
 * text so agents can create/update diagrams by writing the source directly,
 * either through the UI or the `/api/diagrams` endpoint.
 */
export const diagrams = pgTable("diagrams", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Diagram language of `source`. Only 'mermaid' is rendered today; kept as a
  // column so other text formats (d2, dot) can be added without a migration.
  format: text("format").notNull().default("mermaid"),
  source: text("source").notNull(),
  // Soft-delete marker: non-null = archived (hidden from the main list but
  // restorable). Null = active.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Connection = typeof connections.$inferSelect;
export type SavedQuery = typeof savedQueries.$inferSelect;
export type Diagram = typeof diagrams.$inferSelect;

export type Project = typeof projects.$inferSelect;
export type App = typeof apps.$inferSelect;
export type StatusSnapshot = typeof statusSnapshots.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type TaskAttachment = typeof taskAttachments.$inferSelect;
export type AdminLogin = typeof adminLogins.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;
export type ProjectRecipe = typeof projectRecipes.$inferSelect;
