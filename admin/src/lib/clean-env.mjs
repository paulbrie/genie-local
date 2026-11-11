// The environment of what the admin starts on someone else's behalf: a project's app (src/lib/runner.ts) and the tmux
// server behind every terminal (src/lib/terminals.ts, server/pty.mjs). Built from what to KEEP, not from what to drop:
// the admin's own env holds its unit's config (NODE_ENV=production, PORT=3002, APP_BASE_PATH, NEXT_PUBLIC_BASE_PATH),
// Next's and Turbopack's internals, and everything in its .env.local (DATABASE_URL, the Slack and API tokens). Next
// never overrides a variable that's already set with the app's own .env value, so whatever got through won over the
// project's settings, and a list of what to drop fell behind each time the admin got a new one.
//
// Plain Node ESM, so the Next side and the custom server share it.

const KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  // systemd-run --user and systemctl --user find the user manager through these
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  // the box's public host: projects' next.config reads it (allowedDevOrigins, basePath)
  "PUBLIC_HOST",
]);

/** Whether a variable is passed on. */
export function keepEnvKey(key) {
  return KEEP.has(key) || key.startsWith("LC_");
}

/** The kept part of `env` (the admin's own by default), plus `extra`. */
export function cleanEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && keepEnvKey(key)) out[key] = value;
  return Object.assign(out, extra);
}

// What an admin had that isn't in its env any more on this side of a restart: the other instance's (admin-dev runs
// under `next dev`, prod doesn't), or a secret since moved out of .env.local.
const ADMIN_ONLY =
  /^(NODE_ENV|PORT|APP_[A-Z_]+|NEXT_PUBLIC_BASE_PATH|NEXT_RUNTIME|NEXT_DEPLOYMENT_ID|NEXT_PHASE|__NEXT.*|TURBOPACK.*|__TURBOPACK.*|DATABASE_URL|PROJECTS_ROOT|ADMIN_USER|ADMIN_PASSWORD|(DIAGRAMS|BOARDS|BROWSERS)_API_KEY|RAILWAY_API_TOKEN|SLACK_[A-Z_]+|WS_NO_BUFFER_UTIL|INVOCATION_ID|JOURNAL_STREAM|MEMORY_PRESSURE_[A-Z_]+|SYSTEMD_EXEC_PID)$/;

/**
 * Of a tmux server's global environment (`keys`), what an admin left there: not kept, and the admin's own (in
 * `adminEnv`, or one of the names an admin has). Whatever else is there (someone's SSH agent, DISPLAY…) stays.
 */
export function staleTmuxEnvKeys(keys, adminEnv = process.env) {
  return keys.filter((key) => !keepEnvKey(key) && (key in adminEnv || ADMIN_ONLY.test(key)));
}
