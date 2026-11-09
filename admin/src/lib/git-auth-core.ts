// Pure helpers for a repo's saved GitHub remote and token (git-auth.ts, the Git tab's Remote dialog).
// No server-only imports: git-auth-core.test.ts runs them directly.

/**
 * A remote as typed into the Git tab, as the https URL `origin` gets: "owner/repo",
 * "git@github.com:owner/repo.git" and https URLs all work. Credentials in the URL are
 * dropped (the token is kept apart, never in the URL). Throws on anything else.
 */
export function normalizeRemoteUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("a GitHub URL is needed");
  if (/\s/.test(raw)) throw new Error("the URL can't contain spaces");
  const short = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return `https://github.com/${short[1]}/${short[2]}.git`;
  const ssh = raw.match(/^(?:ssh:\/\/)?git@([\w.-]+)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}/${ssh[3]}.git`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("not a URL: use https://github.com/<owner>/<repo>, or <owner>/<repo>");
  }
  if (u.protocol !== "https:") throw new Error("the URL must be https:// (the token works over https)");
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const path = u.pathname.replace(/\/+$/, "");
  if (!/^\/[\w.-]+\/[\w.-]+/.test(path)) throw new Error("the URL needs an owner and a repo: https://github.com/<owner>/<repo>");
  u.pathname = path.endsWith(".git") ? path : `${path}.git`;
  return u.toString();
}

/** A URL fit to show: any user/password in it masked. */
export function redactUrl(url: string): string {
  return url.replace(/^(\w+:\/\/)[^/@\s]+@/, "$1***@");
}

/** The last 4 characters, to tell one token from another without showing it. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/**
 * The environment that has git send `token` to `remoteUrl`'s host, and only there:
 * `http.<scheme>://<host>/.extraheader` through GIT_CONFIG_COUNT/KEY/VALUE (as GitHub's
 * own checkout action does). Nothing touches .git/config, the URL or the command line
 * (so it is not in `ps` either). GitHub takes any PAT, classic or fine-grained, this way.
 */
export function authEnv(remoteUrl: string, token: string): Record<string, string> {
  const u = new URL(remoteUrl);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${u.protocol}//${u.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** GitHub's token formats: classic (ghp_), fine-grained (github_pat_), OAuth/app/refresh (gho_, ghu_, ghs_, ghr_). */
const GITHUB_TOKEN = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/**
 * A GitHub token written into a remote URL (`https://<token>@github.com/…`, or as the password), or null.
 * With the token as the user name and no password, git can't push from here: GitHub refuses the anonymous
 * first try and git then wants to prompt for a password. Push and Refresh send it as a header instead.
 */
export function tokenInUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  if (GITHUB_TOKEN.test(pass)) return pass;
  if (GITHUB_TOKEN.test(user)) return user;
  return null;
}

/** A token as pasted: trimmed, one line, no spaces (else it's a paste gone wrong). */
export function cleanToken(input: string): string {
  const t = input.trim();
  if (!t) throw new Error("the token is empty");
  if (/\s/.test(t)) throw new Error("the token can't contain spaces or line breaks");
  if (t.length > 500) throw new Error("that is too long to be a token");
  return t;
}
