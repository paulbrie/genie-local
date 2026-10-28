// Types for core.mjs (kept as plain JS so the history cron can import it).

export type MemoryProcess = {
  pid: number;
  ppid: number;
  /** Its command line (cut at 300 characters). */
  command: string;
  cwd: string;
  bytes: number;
  estimated: boolean;
  startedAt: number | null;
};

export type MemoryGroup = {
  key: string;
  /** The script ("dev"), else the command ("npm run dev", "chrome"), the container's name, or "claude". */
  label: string;
  kind: "script" | "process" | "agent" | "container";
  /** The project subfolder it runs in ("" = the project's own folder). */
  app: string;
  /** The runner's script, when the admin started it. */
  script: string | null;
  pids: number[];
  /** Its processes, biggest first (none for a container). */
  procs: MemoryProcess[];
  /** The admin terminal it runs in (found by walking up its processes' parents), when it does; set by the app. */
  terminal?: string | null;
  bytes: number;
  /** Some of it is RSS, PSS couldn't be read: an overestimate. */
  estimated: boolean;
};

export type ProjectMemory = {
  slug: string;
  /** Everything but its agents. */
  bytes: number;
  /** Claude sessions working in it. */
  agentBytes: number;
  groups: MemoryGroup[];
};

export type ProjectMemorySnapshot = { ts: number; projects: ProjectMemory[] };

export type ProjectContainer = { project: string; name: string; bytes: number };

export function commandLabel(argv: string[], comm: string): string;
export function projectContainers(root: string): Promise<ProjectContainer[]>;
export function measureProjects(opts: { root: string; runDir: string; containers?: ProjectContainer[] }): Promise<ProjectMemorySnapshot>;
