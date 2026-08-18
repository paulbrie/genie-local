import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const SYSTEMCTL = "systemctl";
const SUDO = "sudo";
const EXEC_OPTS = { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 } as const;

export type ServiceUnit = {
  unit: string; // e.g. "nginx.service"
  load: string; // loaded | not-found | masked | ...
  active: string; // active | inactive | failed | activating | ...
  sub: string; // running | exited | dead | failed | ...
  description: string;
  enabled: string; // enabled | disabled | static | masked | "" (unknown)
  curated: boolean; // part of the default relevant set
  protected: boolean; // stop/disable blocked (would sever the session / host)
};

export type ServicesSnapshot = {
  ts: number;
  available: boolean;
  error?: string;
  services: ServiceUnit[];
};

export const SERVICE_ACTIONS = [
  "start",
  "stop",
  "restart",
  "enable",
  "disable",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export function isServiceAction(v: unknown): v is ServiceAction {
  return (
    typeof v === "string" &&
    (SERVICE_ACTIONS as readonly string[]).includes(v)
  );
}

/**
 * A systemd unit name we accept as an action target. Restricted to the
 * `*.service` units this manager lists, with a conservative charset. The value
 * never reaches a shell (execFile), but the strict pattern keeps a crafted name
 * from turning into an extra systemctl argument.
 */
const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;
export function isServiceUnit(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 && UNIT_RE.test(v);
}

/**
 * Curated "relevant" set shown by default. Exact unit names plus name prefixes
 * for our own project/tooling units. Everything else is still reachable via the
 * manager's "show all" toggle / search.
 */
const CURATED_UNITS = new Set([
  "admin.service",
  "admin-dev.service", // on-demand hot-reload instance (/admin-dev :3002)
  "nginx.service",
  "docker.service",
  "containerd.service",
  "code-server.service",
  "cron.service",
  "ssh.service",
  "sshd.service",
  "postgresql.service",
]);
const CURATED_PREFIXES = ["genie", "ft-", "roa", "godmother", "hmetal", "vps-"];

function isCurated(unit: string): boolean {
  if (CURATED_UNITS.has(unit)) return true;
  return CURATED_PREFIXES.some((p) => unit.startsWith(p));
}

/**
 * Units this manager must never STOP or DISABLE, because doing so would sever
 * the very session controlling it (or knock the host offline). Restart is still
 * allowed for `admin.service` — the UI confirms, and systemd restarts us. Note
 * these are protections against footguns, not a security boundary: the operator
 * already has full sudo on the box.
 */
const PROTECTED: ReadonlySet<string> = new Set([
  "admin.service",
  "ssh.service",
  "sshd.service",
  "systemd-logind.service",
  "dbus.service",
]);

/** Actions that would take a protected unit down / off. */
const DISRUPTIVE_ON_PROTECTED: ReadonlySet<ServiceAction> = new Set([
  "stop",
  "disable",
]);

export function isProtectedAction(
  unit: string,
  action: ServiceAction,
): boolean {
  return PROTECTED.has(unit) && DISRUPTIVE_ON_PROTECTED.has(action);
}

type JsonUnit = { unit?: string; load?: string; active?: string; sub?: string; description?: string };
type JsonUnitFile = { unit_file?: string; state?: string };

function parseJson<T>(stdout: string): T[] {
  try {
    const v = JSON.parse(stdout);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function cleanErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const s = (err.stderr || err.message || String(e)).trim();
  return s.split("\n").slice(0, 3).join(" ").slice(0, 500);
}

/**
 * List service units: loaded units (active + inactive) merged with their
 * enabled/disabled state from unit files. Reads don't need sudo. Never throws.
 */
export async function listServices(): Promise<ServicesSnapshot> {
  const ts = Date.now();
  try {
    const [units, files] = await Promise.all([
      pexec(
        SYSTEMCTL,
        ["list-units", "--type=service", "--all", "--output=json", "--no-pager"],
        EXEC_OPTS,
      ),
      pexec(
        SYSTEMCTL,
        ["list-unit-files", "--type=service", "--output=json", "--no-pager"],
        EXEC_OPTS,
      ),
    ]);

    const enabledByUnit = new Map<string, string>();
    for (const f of parseJson<JsonUnitFile>(files.stdout)) {
      if (f.unit_file) enabledByUnit.set(f.unit_file, f.state ?? "");
    }

    const seen = new Set<string>();
    const services: ServiceUnit[] = [];
    for (const u of parseJson<JsonUnit>(units.stdout)) {
      const unit = u.unit ?? "";
      if (!unit || seen.has(unit)) continue;
      seen.add(unit);
      services.push({
        unit,
        load: u.load ?? "",
        active: u.active ?? "",
        sub: u.sub ?? "",
        description: u.description ?? "",
        enabled: enabledByUnit.get(unit) ?? "",
        curated: isCurated(unit),
        protected: PROTECTED.has(unit),
      });
    }

    // Include unit-file-only entries (installed but never loaded) so disabled
    // services still show up for enabling. These have no live active/sub state.
    for (const [unit, state] of enabledByUnit) {
      if (seen.has(unit) || unit.includes("@")) continue; // skip templates
      seen.add(unit);
      services.push({
        unit,
        load: "",
        active: "inactive",
        sub: "dead",
        description: "",
        enabled: state,
        curated: isCurated(unit),
        protected: PROTECTED.has(unit),
      });
    }

    services.sort((a, b) => a.unit.localeCompare(b.unit));
    return { ts, available: true, services };
  } catch (e) {
    return { ts, available: false, error: cleanErr(e), services: [] };
  }
}

export type ServiceActionResult = { ok: boolean; output?: string; error?: string };

/**
 * Run a lifecycle action on a unit via `sudo -n systemctl`. `-n` fails fast
 * rather than blocking on a password prompt if sudo rules ever change.
 */
export async function runServiceAction(
  unit: string,
  action: ServiceAction,
): Promise<ServiceActionResult> {
  if (!isServiceUnit(unit)) return { ok: false, error: "invalid unit name" };
  if (isProtectedAction(unit, action)) {
    return {
      ok: false,
      error: `${action} is blocked for protected unit ${unit}`,
    };
  }
  try {
    const { stdout, stderr } = await pexec(
      SUDO,
      ["-n", SYSTEMCTL, action, unit],
      EXEC_OPTS,
    );
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}

/** Recent journald lines for a unit (no sudo needed for reads on this host). */
export async function serviceLogs(
  unit: string,
  lines = 500,
): Promise<{ ok: boolean; logs?: string; error?: string }> {
  if (!isServiceUnit(unit)) return { ok: false, error: "invalid unit name" };
  const n = Math.min(Math.max(Math.trunc(lines), 1), 5000);
  try {
    const { stdout } = await pexec(
      "journalctl",
      ["-u", unit, "-n", String(n), "--no-pager", "--output=short-iso"],
      EXEC_OPTS,
    );
    return { ok: true, logs: stdout.trimEnd() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}
