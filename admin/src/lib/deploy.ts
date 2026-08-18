import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// The confined root-owned helper the UI drives via sudo. It builds the prod
// bundle (.next-prod) — optionally after a drizzle migrate — then restarts
// admin.service, and controls the on-demand admin-dev instance. See
// admin/ops/admin-ctl. genie may run ONLY this as root (scoped sudoers).
const ADMIN_CTL = "/usr/local/bin/admin-ctl";
const SUDO = "sudo";
const EXEC_OPTS = { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 } as const;

/** Log id (relative to /tmp) the deploy streams to; open with the Logs page. */
export const DEPLOY_LOG = "projects/admin-deploy.log";

export type DeployState = "none" | "running" | "success" | "failed";

export type DeployStatus = {
  /** systemd `is-active` for the prod (/admin :3001) unit. */
  prod: string;
  /** systemd `is-active` for the dev (/admin-dev :3002) unit. */
  dev: string;
  /** Outcome of the most recent deploy. */
  deploy: DeployState;
  /** Epoch seconds of that outcome, when known. */
  deployTs: number | null;
};

function cleanErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || "command failed").trim();
}

/** Parse `admin-ctl status` (three `k=v` lines) into a typed snapshot. */
export async function deployStatus(): Promise<DeployStatus> {
  const out: DeployStatus = {
    prod: "unknown",
    dev: "unknown",
    deploy: "none",
    deployTs: null,
  };
  try {
    const { stdout } = await pexec(SUDO, ["-n", ADMIN_CTL, "status"], EXEC_OPTS);
    for (const line of stdout.split("\n")) {
      const [k, v] = line.split("=");
      if (k === "prod") out.prod = (v ?? "").trim();
      else if (k === "dev") out.dev = (v ?? "").trim();
      else if (k === "deploy") {
        // "RUNNING <epoch>" | "SUCCESS <epoch>" | "FAILED <epoch>" | "none"
        const [word, ts] = v.trim().split(/\s+/);
        const map: Record<string, DeployState> = {
          RUNNING: "running",
          SUCCESS: "success",
          FAILED: "failed",
        };
        out.deploy = map[word] ?? "none";
        out.deployTs = ts ? Number(ts) * 1000 : null;
      }
    }
  } catch {
    /* helper missing or sudo denied — leave the "unknown"/"none" defaults */
  }
  return out;
}

/**
 * Kick off a prod build + deploy. Returns immediately; the helper detaches the
 * build and streams progress to DEPLOY_LOG. Poll deployStatus() for the outcome.
 */
export async function startDeploy(
  migrate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const args = ["-n", ADMIN_CTL, "deploy", ...(migrate ? ["--migrate"] : [])];
  try {
    const { stdout, stderr } = await pexec(SUDO, args, EXEC_OPTS);
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}
