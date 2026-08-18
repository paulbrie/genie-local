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
