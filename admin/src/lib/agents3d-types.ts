import type { CommsModel } from "@/lib/claude-comms-parse";

/** A tool call mapped onto a repo: `repo` is the repo's top dir, `path` repo-relative. */
export type AgentEvent = { t: string; tool: string; repo: string | null; path: string | null };

export type RepoLayout = {
  /** Repo top directory. */
  id: string;
  name: string;
  project: string | null;
  app: string | null;
  /** Tracked files (and untracked new ones) with their size in bytes. */
  files: { p: string; s: number }[];
  /** Paths with uncommitted changes and their mtime (ms), a proxy for edits made through Bash. */
  dirty: { p: string; m: number }[];
  truncated: boolean;
};

export type Agents3DModel = {
  version: string;
  reposVersion: string;
  comms: Omit<CommsModel, "activity">;
  activity: Record<string, AgentEvent[]>;
  repos: RepoLayout[];
  /** Node key → top dir of the repo its cwd is in. */
  nodeRepos: Record<string, string>;
};

/** What the API sends: repos only when they changed, activity only after `since`. */
export type Agents3DResponse =
  | { unchanged: true; version: string }
  | (Omit<Agents3DModel, "repos" | "activity"> & {
      repos: RepoLayout[] | null;
      activity: Record<string, AgentEvent[]>;
      /** True when `activity` holds only events after the client's `since`. */
      partial: boolean;
    });
