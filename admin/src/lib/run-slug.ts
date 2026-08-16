// Pure, dependency-free — safe to import from BOTH server and client code.
// Keep in sync with the log/pid file names produced by src/lib/runner.ts.

const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * Stable per-(app, script) id used for log + pid file names,
 * e.g. runSlug("roa","server-app","dev") -> "roa-server-app-dev".
 * Omitting `script` yields the app-level prefix ("roa-server-app").
 */
export function runSlug(
  projectSlug: string,
  appSlug: string,
  script?: string,
): string {
  const raw = [projectSlug, appSlug, script].filter(Boolean).join("-");
  return raw.replace(UNSAFE, "-").replace(/^-+|-+$/g, "") || "app";
}

/**
 * A sensible pre-set value for the Logs sidebar filter when deep-linking to
 * `logFile` (`?filter=…`). Returns the file's basename without directory or
 * `.log` — i.e. the run slug (`projects/roa-server-app-dev.log` ->
 * `roa-server-app-dev`). When `script` is given, its trailing `-<script>`
 * segment is stripped so a script's log groups with its app siblings
 * (dev/build/lint -> `roa-server-app`). Matches the sidebar's substring filter
 * over each file's relative path.
 */
export function logFilter(logFile: string, script?: string): string {
  const base = (logFile.split(/[\\/]/).pop() ?? logFile).replace(/\.log$/i, "");
  if (script) {
    const suffix = `-${runSlug("", "", script)}`;
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

/** The dashboard treats an app as "running" when its dev or start server is up. */
export function isAppServerRunning(
  running: Set<string>,
  projectSlug: string,
  appSlug: string,
): boolean {
  return (
    running.has(runSlug(projectSlug, appSlug, "dev")) ||
    running.has(runSlug(projectSlug, appSlug, "start"))
  );
}

/**
 * Resident memory (bytes) of an app's server — the sum of its dev + start run
 * slugs in the memory map (only one is normally live). 0 when nothing is running.
 */
export function appServerMemBytes(
  memory: Record<string, number>,
  projectSlug: string,
  appSlug: string,
): number {
  return (
    (memory[runSlug(projectSlug, appSlug, "dev")] ?? 0) +
    (memory[runSlug(projectSlug, appSlug, "start")] ?? 0)
  );
}
