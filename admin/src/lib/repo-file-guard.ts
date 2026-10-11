import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Reading a repo file for the Ops view's code window (T197), safely. A file is read only when it is one the map
 * shows (a file of a repo laid out for Agents City), stays inside that repo once `..` and symlinks are resolved, is
 * a regular text file of at most MAX_BYTES, isn't a secret by its name (.env*, keys, credentials, the usual
 * secret stores) and holds nothing the team's secrets hook would stop (a password in a URL, an API key, a token,
 * a private key, a secret assignment). Anything else is refused with the reason; nothing of a refused file is sent.
 */

export const MAX_BYTES = 1024 * 1024;

/** names (lower-case basename) that are secrets whatever they hold */
const SECRET_NAMES = [
  /^\.env(\..*)?$/, /^\.envrc$/, /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx|ppk)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^id_[a-z0-9_]+$/,
  /^\.?(git-)?credentials(\..*)?$/, /credentials\.(md|json|ya?ml|txt)$/,
  /^\.netrc$/, /^\.pgpass$/, /^\.npmrc$/, /^\.pypirc$/, /^\.htpasswd$/,
  /^secrets?(\..*)?$/, /^agent-browser-state\.json$/, /^auth\.json$/, /^\.?token(s)?(\..*)?$/,
];
/** folders whose files are secrets */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker", ".config/gcloud", "secrets", ".secrets"]);

/** the team's secrets hook's patterns (/home/genie/team/hooks/no-secrets-in-messages.py), the same ones */
export const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s@]+@/i, "a database URL with a password"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic API key"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:DATABASE_URL|[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY))\s*=\s*\S{6,}/, "a secret assignment"],
];

/** why a repo-relative path may not be shown by its name alone, or null */
export function nameRefusal(rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return "not a path inside the repo";
  const parts = rel.toLowerCase().split("/"), base = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) if (SECRET_DIRS.has(parts[i]) || SECRET_DIRS.has(parts.slice(i, i + 2).join("/"))) return "it is in a folder of secrets";
  if (SECRET_NAMES.some((rx) => rx.test(base))) return "its name says it holds secrets (.env, a key, credentials)";
  return null;
}

/** why a file's bytes may not be shown, or null: binary, or something the secrets hook stops */
export function contentRefusal(buf: Buffer): string | null {
  if (buf.subarray(0, 8000).includes(0)) return "it is a binary file";
  const text = buf.toString("utf8");
  for (const [rx, what] of SECRET_PATTERNS) if (rx.test(text)) return `it holds what looks like ${what}`;
  return null;
}

export type FileRead = { ok: true; text: string; bytes: number } | { ok: false; status: 403 | 404 | 413 | 415; error: string };

/**
 * `rel` of the repo at `top`, if `shown` (the repo's files on the map) has it and every check passes. `top` must be
 * a repo the map shows (the caller's allow-list).
 */
export async function readRepoFile(top: string, rel: string, shown: Set<string> | undefined): Promise<FileRead> {
  const byName = nameRefusal(rel);
  if (byName) return { ok: false, status: 403, error: `Not shown: ${byName}.` };
  if (!shown?.has(rel)) return { ok: false, status: 404, error: "Not a file on the map." };
  let root: string, real: string;
  try {
    root = await fs.realpath(top);
    real = await fs.realpath(path.resolve(top, rel));
  } catch {
    return { ok: false, status: 404, error: "The file isn't there any more." };
  }
  // (a symlink, or anything else, leading out of the repo)
  if (real !== root && !real.startsWith(root + path.sep)) return { ok: false, status: 403, error: "Not shown: it leads outside the repo." };
  const realRefusal = nameRefusal(path.relative(root, real));
  if (realRefusal) return { ok: false, status: 403, error: `Not shown: ${realRefusal}.` };
  const st = await fs.stat(real);
  if (!st.isFile()) return { ok: false, status: 415, error: "Not a regular file." };
  if (st.size > MAX_BYTES) return { ok: false, status: 413, error: `Too big to show (${Math.round(st.size / 1024)} kB; at most ${MAX_BYTES / 1024} kB).` };
  const buf = await fs.readFile(real);
  const byContent = contentRefusal(buf);
  if (byContent) return { ok: false, status: byContent.startsWith("it is a binary") ? 415 : 403, error: `Not shown: ${byContent}.` };
  return { ok: true, text: buf.toString("utf8"), bytes: buf.length };
}
