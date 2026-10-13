// What the file explorer shows of a folder (T243), what counts as a secret (shown, never previewed), how big a
// folder is (for the delete confirm), and which running processes work inside a folder.

import { promises as fs } from "node:fs";
import path from "node:path";

import { isWithin } from "./guard";

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number;
  modified: string;
  /** a credential or key: listed, downloadable behind a confirm, never previewed */
  secret: boolean;
}

const SECRET_NAME = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^(\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|\.dockercfg)$/i,
  /^\.?credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml|env)$/i,
  /^service-account.*\.json$/i,
];
/** folders whose every file is secret */
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".docker"]);

/** true for a credential or key file, by its name or by a secret folder on its path */
export function isSecretPath(abs: string): boolean {
  const name = path.basename(abs);
  if (SECRET_NAME.some((re) => re.test(name))) return true;
  return abs.split(path.sep).slice(0, -1).some((seg) => SECRET_DIRS.has(seg));
}

/** a folder's entries, folders first then by name (the page sorts as asked) */
export async function listDir(abs: string): Promise<FileEntry[]> {
  const names = await fs.readdir(abs);
  const out: FileEntry[] = [];
  await Promise.all(
    names.map(async (name) => {
      const p = path.join(abs, name);
      const st = await fs.lstat(p).catch(() => null);
      if (!st) return;
      const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other";
      out.push({ name, path: p, type, size: st.isFile() ? st.size : 0, modified: st.mtime.toISOString(), secret: type !== "dir" && isSecretPath(p) });
    }),
  );
  return out.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
}

/** a folder's size and file count, walked without following symlinks; stops (truncated) after `maxEntries` or `ms` */
export async function folderSize(abs: string, maxEntries = 200_000, ms = 4000): Promise<{ bytes: number; files: number; truncated: boolean }> {
  const deadline = Date.now() + ms;
  let bytes = 0, files = 0, seen = 0, truncated = false;
  const stack = [abs];
  while (stack.length) {
    if (seen > maxEntries || Date.now() > deadline) { truncated = true; break; }
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        bytes += (await fs.lstat(p).catch(() => null))?.size ?? 0;
      }
    }
  }
  return { bytes, files, truncated };
}

/** the admin's run dir (runner.ts): one `<slug>.pid` per process it started */
const RUN_DIR = "/tmp/projects";

/** the processes the admin runs (Run on a project's scripts) whose working folder is `abs` or inside it */
export async function runningInside(abs: string, runDir = RUN_DIR): Promise<{ slug: string; pid: number; cwd: string }[]> {
  const names = await fs.readdir(runDir).catch(() => [] as string[]);
  const out: { slug: string; pid: number; cwd: string }[] = [];
  for (const n of names.filter((x) => x.endsWith(".pid"))) {
    const pid = Number((await fs.readFile(path.join(runDir, n), "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const cwd = await fs.realpath(`/proc/${pid}/cwd`).catch(() => null);
    if (cwd && isWithin(cwd, abs)) out.push({ slug: n.slice(0, -4), pid, cwd });
  }
  return out;
}
