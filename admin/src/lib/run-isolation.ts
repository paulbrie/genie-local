// How a project's app is run (src/lib/runner.ts): its settings, and the systemd-run / docker run command lines for
// them. Pure, so it's tested (run-isolation.test.ts).
//
//  · process (the default): `npm run <script>` on the box, in a systemd user scope of its own
//    (spiridus-<slug>-<id>.scope) when genie's user manager runs (`loginctl enable-linger genie`): a cgroup per run,
//    so the memory and CPU caps hold for all of it, and Stop takes everything in it, strays included.
//  · docker: the same `npm run <script>` in a container: the project mounted at its own path, host networking (its
//    PORT, the databases on localhost and the nginx route stay as they are), running as genie, so what it writes is
//    genie's. Only the environment and the system libraries are the container's.

export const RUN_ISOLATIONS = ["process", "docker"] as const;
export type RunIsolation = (typeof RUN_ISOLATIONS)[number];

export type RunSettings = {
  isolation: RunIsolation;
  /** Docker image; null = {@link defaultImage}. */
  image: string | null;
  /** Memory cap in MB; null = none. */
  memMaxMb: number | null;
  /** CPU cap in cores (1.5 = one and a half); null = none. */
  cpus: number | null;
};

export const DEFAULT_RUN: RunSettings = { isolation: "process", image: null, memMaxMb: null, cpus: null };

/** An image reference (name, tag, digest), never one that reads as an option. */
export const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;

/**
 * The image an app runs in unless it names one: Node at the app's pinned major, else the host's (node_modules were
 * installed by the host's npm). Debian 13: its glibc (2.41) is newer than the host's (Ubuntu 24.04, 2.39), so native
 * modules built here load there; Alpine's musl wouldn't load them at all.
 */
export function defaultImage(nodeMajor: number): string {
  return `node:${nodeMajor}-trixie-slim`;
}

/** The major version a .nvmrc / .node-version pins ("v20.11.1", "22", "22.x"); null for "lts/iron", "node"… */
export function pinnedNodeMajor(text: string): number | null {
  const m = /^\s*v?(\d+)(?:[.\s]|$)/.exec(text);
  const major = m ? Number(m[1]) : NaN;
  return major >= 4 && major < 100 ? major : null;
}

/** The scope a run gets: unique, so a run whose strays outlived it never blocks the next. */
export function scopeUnit(slug: string, now = Date.now()): string {
  return `spiridus-${slug}-${now.toString(36)}.scope`;
}

/** `systemd-run` arguments running `argv` in a user scope with the caps. */
export function scopeArgs(unit: string, s: Pick<RunSettings, "memMaxMb" | "cpus">, argv: string[]): string[] {
  const props: string[] = [];
  if (s.memMaxMb) props.push("-p", `MemoryMax=${s.memMaxMb}M`, "-p", "MemorySwapMax=0");
  if (s.cpus) props.push("-p", `CPUQuota=${Math.round(s.cpus * 100)}%`);
  return ["--user", "--scope", "--collect", `--unit=${unit}`, `--description=Spiridus ${unit}`, ...props, "--", ...argv];
}

/** The container a run gets ("spiridus-shop-app-dev"): one per app and script. */
export function containerName(slug: string): string {
  return `spiridus-${slug}`;
}

// The container has its own of these; the rest of the clean env (PORT, PUBLIC_HOST, the locale…) goes in.
const HOST_ONLY = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);

/** The names of the variables passed into the container (their values come from docker's own env, not argv). */
export function containerEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => !HOST_ONLY.has(k));
}

export type DockerRun = {
  name: string;
  image: string;
  /** The project's folder: mounted at its own path, so the paths in caches and configs stay true. */
  projectDir: string;
  appDir: string;
  uid: number;
  gid: number;
  envKeys: string[];
  memMaxMb: number | null;
  cpus: number | null;
  /** Docker writes the container's id here: the runner finds its cgroup (memory) and stops it by it. */
  cidFile: string;
  slug: string;
  argv: string[];
};

/** `docker run` arguments for a run. */
export function dockerRunArgs(o: DockerRun): string[] {
  if (o.projectDir.includes(":")) throw new Error(`can't mount ${o.projectDir} (a colon in the path)`);
  if (!IMAGE_RE.test(o.image)) throw new Error(`not an image: ${o.image}`);
  return [
    "run",
    "--rm",
    // tini as PID 1: passes docker stop's SIGTERM on to npm, and reaps
    "--init",
    `--name=${o.name}`,
    `--cidfile=${o.cidFile}`,
    `--label=spiridus.run=${o.slug}`,
    "--network=host",
    `--user=${o.uid}:${o.gid}`,
    `--volume=${o.projectDir}:${o.projectDir}`,
    `--workdir=${o.appDir}`,
    ...o.envKeys.flatMap((k) => ["--env", k]),
    ...(o.memMaxMb ? [`--memory=${o.memMaxMb}m`, `--memory-swap=${o.memMaxMb}m`] : []),
    ...(o.cpus ? [`--cpus=${o.cpus}`] : []),
    o.image,
    ...o.argv,
  ];
}

/**
 * What a container has in memory, from its cgroup's memory.current and memory.stat: as `docker stats` counts it, less
 * the page cache it could give back (inactive_file).
 */
export function cgroupMemBytes(current: string, stat: string): number {
  const total = Number(current.trim());
  if (!Number.isFinite(total)) return 0;
  const inactive = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);
  return Math.max(0, total - inactive);
}
