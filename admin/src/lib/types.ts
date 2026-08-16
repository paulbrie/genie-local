/**
 * Plain, serializable signal shapes. Safe to pass from Server Components to
 * Client Components as props (no Date/class instances).
 */

export type GitSignals = {
  branch: string | null;
  dirty: boolean | null;
  dirtyCount: number | null;
  ahead: number | null;
  behind: number | null;
  lastCommitHash: string | null;
  lastCommitAt: string | null; // ISO string
};

export type FsSignals = {
  dirMtime: string | null; // ISO string
  sizeBytes: number | null;
  hasPackageJson: boolean;
  hasEnv: boolean;
  hasReadme: boolean;
  hasDockerfile: boolean;
};

export type PkgSignals = {
  name: string | null;
  scripts: string[];
  dependencyCount: number | null;
};

/** Signals for a single app (sub-project) within a project. */
export type AppSignals = {
  slug: string; // dir name relative to the project; '' = the project root itself
  path: string;
  name: string | null;
  isGit: boolean;
  git: GitSignals;
  fs: FsSignals;
  pkg: PkgSignals;
  errors: string[];
};

/** A project directory and the apps discovered inside it. */
export type ProjectSignals = {
  slug: string;
  path: string;
  apps: AppSignals[];
};
