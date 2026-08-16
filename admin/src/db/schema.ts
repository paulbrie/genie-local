import {
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
 * `.git` and/or `package.json` (e.g. roa/server-app, roa/server-admin). When a
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
  sizeBytes: integer("size_bytes"),
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
  done: boolean("done").notNull().default(false),
  // Manual sort order within a project (smaller = higher in the list).
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export type Connection = typeof connections.$inferSelect;
export type SavedQuery = typeof savedQueries.$inferSelect;

export type Project = typeof projects.$inferSelect;
export type App = typeof apps.$inferSelect;
export type StatusSnapshot = typeof statusSnapshots.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Task = typeof tasks.$inferSelect;
