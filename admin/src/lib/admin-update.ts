import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEPLOY_LOG, startDeploy } from "@/lib/deploy";

const pexec = promisify(execFile);

/**
 * Updating the admin from GitHub: tell whether origin has anything we don't,
 * and, when asked, take it and ship it.
 *
 * The repo belongs to genie, so the git side needs no privileges; only the last
 * step does, and that goes through the same scoped `admin-ctl deploy` the
 * Services page already uses. Nothing here force-updates: the pull is
 * fast-forward only, so local commits or edits in the way stop it with a
 * message rather than being thrown away.
 */

const GIT_OPTS = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 };
/** The app lives in admin/ inside the repo. Overridable so it can be tested. */
const REPO = process.env.ADMIN_REPO || "/opt/project";

export type UpdateStatus = {
  branch: string;
  /** Commits origin has that we don't. */
  behind: number;
  /** Commits we have that origin doesn't. */
  ahead: number;
  /** Subject lines of what's waiting, newest first. */
  incoming: string[];
  /** Files changed locally and not committed, which a pull could collide with. */
  dirty: number;
  /** Why an update can't run now, if it can't. */
  blocked: string | null;
  checkedAt: number;
};

async function git(args: string[], timeout = GIT_OPTS.timeout) {
  const { stdout } = await pexec("git", ["-C", REPO, ...args], { ...GIT_OPTS, timeout });
  return stdout.trim();
}

/** What GitHub has that this checkout doesn't. Fetches first, so it's current. */
export async function updateStatus(): Promise<UpdateStatus> {
  const out: UpdateStatus = {
    branch: "",
    behind: 0,
    ahead: 0,
    incoming: [],
    dirty: 0,
    blocked: null,
    checkedAt: Date.now(),
  };
  try {
    out.branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    // Talks to GitHub: the slowest step here, hence its own longer limit.
    await git(["fetch", "--quiet", "origin", out.branch], 45_000);
    const counts = await git(["rev-list", "--left-right", "--count", `${out.branch}...origin/${out.branch}`]);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    out.ahead = ahead || 0;
    out.behind = behind || 0;
    if (out.behind) {
      const log = await git(["log", "--format=%s", "-12", `${out.branch}..origin/${out.branch}`]);
      out.incoming = log ? log.split("\n") : [];
    }
    const status = await git(["status", "--porcelain"]);
    out.dirty = status ? status.split("\n").filter((l) => !l.startsWith("??")).length : 0;

    if (!out.behind) out.blocked = null;
    else if (out.ahead) out.blocked = `This checkout has ${out.ahead} commit(s) of its own — merge or push them first.`;
    else if (out.dirty) out.blocked = `${out.dirty} file(s) changed here and not committed — a pull could collide with them.`;
  } catch (e) {
    out.blocked = `Couldn't reach the repository: ${(e as Error).message.split("\n")[0].slice(0, 160)}`;
  }
  return out;
}

export type UpdateResult = {
  ok: boolean;
  /** What happened, step by step, for the toast and the log. */
  steps: string[];
  error?: string;
  /** Where to watch the build that follows. */
  log: string;
};

/**
 * Bring the checkout up to date with origin: fast-forward, and reinstall
 * packages if the lockfile moved. Returns what it did, or why it wouldn't.
 * Kept apart from the deploy so the risky half can be exercised on its own.
 */
export async function fastForward(): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const steps: string[] = [];
  const fail = (error: string) => ({ ok: false, steps, error });

  const status = await updateStatus();
  if (status.blocked) return fail(status.blocked);
  if (!status.behind) return fail("Already up to date with GitHub.");

  const before = await git(["rev-parse", "HEAD"]).catch(() => "");
  try {
    await git(["merge", "--ff-only", `origin/${status.branch}`]);
    steps.push(`Fast-forwarded ${status.branch} by ${status.behind} commit(s).`);
  } catch (e) {
    return fail(`Couldn't fast-forward: ${(e as Error).message.split("\n").slice(-2).join(" ").slice(0, 200)}`);
  }

  // Packages only when the lockfile actually moved — npm ci is the slow part.
  try {
    const changed = await git(["diff", "--name-only", before, "HEAD"]);
    if (changed.split("\n").includes("admin/package-lock.json")) {
      steps.push("Lockfile changed — reinstalling packages…");
      // The shell this inherits sets NODE_ENV=production, which would skip the
      // very packages the build needs.
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ["NODE_ENV"]) delete env[key];
      await pexec("npm", ["ci", "--no-audit", "--no-fund"], {
        cwd: `${REPO}/admin`,
        env,
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      steps.push("Packages reinstalled.");
    }
  } catch (e) {
    return fail(`Pulled, but installing packages failed: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
  }
  return { ok: true, steps };
}

/**
 * Take what's on GitHub and ship it: fast-forward, then hand over to
 * `admin-ctl deploy`, which builds, migrates and restarts the admin — so the
 * page that asked for this will blink.
 */
export async function runUpdate(): Promise<UpdateResult> {
  const pulled = await fastForward();
  if (!pulled.ok) return { ...pulled, log: DEPLOY_LOG };

  // Migrations run as part of the deploy: an update may well bring some.
  const deploy = await startDeploy(true);
  if (!deploy.ok) {
    return { ok: false, steps: pulled.steps, error: `Pulled, but the deploy wouldn't start: ${deploy.error ?? "unknown"}`, log: DEPLOY_LOG };
  }
  return { ok: true, steps: [...pulled.steps, "Building and restarting — the admin will blink."], log: DEPLOY_LOG };
}
