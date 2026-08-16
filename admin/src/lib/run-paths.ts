import "server-only";

/**
 * Where agent/pipeline run files live. Unlike the app-script runner (which logs
 * to /tmp/projects), these are PERSISTENT so the run history survives a reboot:
 * a directory on the project disk, deliberately OUTSIDE the admin app dir so the
 * `next dev` file-watcher doesn't recompile on every log write. Override with
 * AGENT_RUNS_ROOT.
 */
export const AGENT_RUNS_ROOT =
  process.env.AGENT_RUNS_ROOT ?? "/opt/project/.run-logs";

/**
 * Logs-page namespace for run files. Their `.log` files aren't under LOGS_ROOT
 * (/tmp), so the Logs list/tail address them as `run-logs/<runId>.log`; the logs
 * lib maps this prefix back to AGENT_RUNS_ROOT. Keep in sync with src/lib/logs.ts.
 */
export const AGENT_RUNS_PREFIX = "run-logs";
