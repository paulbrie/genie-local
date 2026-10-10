import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Root of the system Nginx config tree. Overridable for tests. */
const NGINX_ROOT = process.env.NGINX_CONFIG_ROOT ?? "/etc/nginx";
/** Root-owned helper genie may run passwordless (only `nginx -t && reload`). */
const RELOAD_CMD =
  process.env.NGINX_RELOAD_CMD ?? "/usr/local/bin/ft-nginx-reload";
/** The genie-owned include the admin regenerates from the DB — shown read-only. */
const PROJECTS_CONF_PATH =
  process.env.NGINX_PROJECTS_CONF ?? "/opt/project/admin/nginx/projects.conf";
/** Timestamped copies of every file we overwrite live here (outside any glob). */
const BACKUP_DIR = path.join(NGINX_ROOT, ".ft-backups");
/** How many backups to keep per file before pruning the oldest. */
const KEEP_BACKUPS = 10;

const EXEC_OPTS = { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 } as const;

// Files/dirs the editor exposes. `nginx.conf` is a top-level single file; the
// rest are directories whose immediate (non-hidden) files are each editable.
const EDIT_FILES = ["nginx.conf"] as const;
const EDIT_DIRS = ["sites-available", "conf.d", "snippets"] as const;

// Config filenames come straight from the filesystem; only accept a safe
// charset so a requested path can never escape its directory or smuggle an
// extra argument into a privileged command.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export type NginxFile = {
  /** Path relative to NGINX_ROOT, e.g. "sites-available/ft-admin". */
  path: string;
  /** Directory group for the UI ("(root)", "sites-available", …). */
  group: string;
  /** Basename shown in the list. */
  name: string;
  size: number;
  editable: boolean;
  /** For sites-available entries: whether a symlink in sites-enabled exists. */
  enabled?: boolean;
};

export type NginxFilesSnapshot = {
  root: string;
  files: NginxFile[];
};

/**
 * Map a client-supplied relative path to an absolute path we are willing to
 * edit, or null if it is not an allowed target. Only top-level `nginx.conf` and
 * single-level files under the EDIT_DIRS qualify; `..`, nested paths, and unsafe
 * names are all rejected.
 */
function resolveEditable(rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const parts = rel.split("/");
  if (parts.length === 1) {
    return (EDIT_FILES as readonly string[]).includes(parts[0])
      ? path.join(NGINX_ROOT, parts[0])
      : null;
  }
  if (parts.length === 2) {
    const [dir, name] = parts;
    if (!(EDIT_DIRS as readonly string[]).includes(dir)) return null;
    // No hidden names: this also rules out "." and "..", which SAFE_NAME alone
    // would let through ("sites-available/.." is /etc/nginx itself).
    if (name.startsWith(".") || !SAFE_NAME.test(name)) return null;
    return path.join(NGINX_ROOT, dir, name);
  }
  return null;
}

/** resolveEditable(), and the target must exist as a regular file. */
async function resolveEditableFile(rel: string): Promise<string | null> {
  const abs = resolveEditable(rel);
  if (!abs) return null;
  try {
    return (await fs.stat(abs)).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** List every file the editor exposes, plus the read-only generated include. */
export async function listNginxFiles(): Promise<NginxFilesSnapshot> {
  const files: NginxFile[] = [];

  for (const f of EDIT_FILES) {
    try {
      const st = await fs.stat(path.join(NGINX_ROOT, f));
      if (st.isFile())
        files.push({
          path: f,
          group: "(root)",
          name: f,
          size: st.size,
          editable: true,
        });
    } catch {
      /* missing — skip */
    }
  }

  // Which sites-available files are symlinked into sites-enabled.
  const enabled = new Set<string>();
  try {
    for (const name of await fs.readdir(path.join(NGINX_ROOT, "sites-enabled")))
      enabled.add(name);
  } catch {
    /* no sites-enabled — fine */
  }

  for (const dir of EDIT_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(NGINX_ROOT, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || !SAFE_NAME.test(name)) continue;
      let st;
      try {
        st = await fs.stat(path.join(NGINX_ROOT, dir, name));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      files.push({
        path: `${dir}/${name}`,
        group: dir,
        name,
        size: st.size,
        editable: true,
        ...(dir === "sites-available"
          ? { enabled: enabled.has(name) }
          : {}),
      });
    }
  }

  // The DB-generated include: viewable so operators can see the live routes,
  // but not editable here (the admin overwrites it on any port change).
  try {
    const st = await fs.stat(PROJECTS_CONF_PATH);
    files.push({
      path: "@generated/projects.conf",
      group: "generated",
      name: "projects.conf",
      size: st.size,
      editable: false,
    });
  } catch {
    /* not generated yet — skip */
  }

  return { root: NGINX_ROOT, files };
}

/** Read one file's contents. Handles the read-only generated include too. */
export async function readNginxFile(
  rel: string,
): Promise<{ ok: true; content: string; editable: boolean } | { ok: false; error: string }> {
  if (rel === "@generated/projects.conf") {
    try {
      return {
        ok: true,
        editable: false,
        content: await fs.readFile(PROJECTS_CONF_PATH, "utf8"),
      };
    } catch (e) {
      return { ok: false, error: cleanErr(e) };
    }
  }
  if (!resolveEditable(rel)) return { ok: false, error: "path not allowed" };
  const abs = await resolveEditableFile(rel);
  if (!abs) return { ok: false, error: "file not found" };
  try {
    // Nginx configs are world-readable (0644 root), so reads need no sudo.
    return { ok: true, editable: true, content: await fs.readFile(abs, "utf8") };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}

export type NginxWriteResult = {
  ok: boolean;
  /** Human summary for a toast. */
  message: string;
  /** `nginx -t` output (stderr), shown verbatim on failure or success. */
  test?: string;
};

/**
 * Overwrite a config file, then validate and reload — transactionally:
 *   1. back up the current file under BACKUP_DIR,
 *   2. write the new content,
 *   3. `nginx -t`; on failure restore the backup and report the error,
 *   4. on success reload via the confined helper.
 * The file is root-owned, so the write/backup/restore steps go through `sudo`
 * (genie already has full sudo on the box — see lib/services.ts). `cp` onto the
 * existing target preserves its owner and mode.
 */
export async function writeNginxFile(
  rel: string,
  content: string,
): Promise<NginxWriteResult> {
  if (!resolveEditable(rel)) return { ok: false, message: "path not allowed" };

  // Require the target to already exist as a regular file — this editor updates
  // config, it does not create new server blocks from whole cloth.
  const abs = await resolveEditableFile(rel);
  if (!abs) return { ok: false, message: "file not found" };

  const stamp = timestamp();
  const backup = path.join(BACKUP_DIR, `${rel.replace(/\//g, "__")}.${stamp}.bak`);

  // Stage the new content in a genie-owned temp file, then `cp` it in as root.
  // A fresh mkdtemp dir plus "wx" (fail if it exists): no predictable /tmp name
  // for a planted symlink to redirect the write.
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nginx-"));
    const tmp = path.join(tmpDir, "new.conf");
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });

    await sudo(["mkdir", "-p", BACKUP_DIR]);
    await sudo(["cp", "-a", abs, backup]);
    await sudo(["cp", tmp, abs]);
  } catch (e) {
    return { ok: false, message: `write failed: ${cleanErr(e)}` };
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // Validate. `nginx -t` writes its report to stderr in both cases.
  let test = "";
  try {
    const r = await sudo(["nginx", "-t"]);
    test = `${r.stderr}${r.stdout}`.trim();
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    test = (err.stderr || err.stdout || err.message || "").trim();
    // Roll back so the running server is never left with a broken include.
    await sudo(["cp", backup, abs]).catch(() => {});
    return {
      ok: false,
      message: "nginx -t failed — changes rolled back",
      test,
    };
  }

  // Config is valid; reload through the locked-down helper (re-runs nginx -t).
  try {
    const r = await execFileAsync("sudo", ["-n", RELOAD_CMD], EXEC_OPTS);
    await pruneBackups(rel).catch(() => {});
    return {
      ok: true,
      message: (r.stdout || r.stderr || "saved and reloaded").trim(),
      test,
    };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      ok: false,
      message: `saved, but reload failed: ${(err.stderr || err.message || "").trim()}`,
      test,
    };
  }
}

/** Run `sudo -n <argv>` and resolve with its stdio (throws on non-zero). */
function sudo(argv: string[]) {
  return execFileAsync("sudo", ["-n", ...argv], EXEC_OPTS);
}

/** Keep only the newest KEEP_BACKUPS copies of a file; delete the rest. */
async function pruneBackups(rel: string): Promise<void> {
  const prefix = `${rel.replace(/\//g, "__")}.`;
  let names: string[];
  try {
    names = await fs.readdir(BACKUP_DIR);
  } catch {
    return;
  }
  const mine = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".bak"))
    .sort() // stamp is zero-padded + lexicographically ordered by time
    .reverse();
  const stale = mine.slice(KEEP_BACKUPS);
  if (stale.length)
    await sudo(["rm", "-f", ...stale.map((n) => path.join(BACKUP_DIR, n))]).catch(
      () => {},
    );
}

/** Sortable UTC stamp: 2026-09-14T13-30-05-123Z. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cleanErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err?.stderr || err?.message || String(e)).trim();
}
