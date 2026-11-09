import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { gitCredentials } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { getProjectIdBySlug } from "@/lib/data";
import { authEnv, cleanToken, normalizeRemoteUrl, redactUrl, tokenHint, tokenInUrl } from "@/lib/git-auth-core";
import { resolveRepo } from "@/lib/git-graph";

const run = promisify(execFile);
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

export type SavedRemote = { remoteUrl: string; hasToken: boolean; tokenHint: string | null; updatedAt: Date };

async function projectId(slug: string): Promise<number> {
  const id = await getProjectIdBySlug(slug);
  if (id === null) throw new Error(`no project ${slug}`);
  return id;
}

async function row(slug: string, app: string) {
  const [r] = await db
    .select()
    .from(gitCredentials)
    .where(and(eq(gitCredentials.projectId, await projectId(slug)), eq(gitCredentials.app, app)));
  return r ?? null;
}

/** What the Git tab's Remote dialog shows for a repo: the saved URL and whether a token is saved (never the token). */
export async function savedRemote(slug: string, app: string): Promise<SavedRemote | null> {
  const r = await row(slug, app);
  return r ? { remoteUrl: r.remoteUrl, hasToken: !!r.tokenEnc, tokenHint: r.tokenHint, updatedAt: r.updatedAt } : null;
}

/**
 * The extra environment for git talking to a repo's remote: its saved token as an auth header
 * for the saved URL's host (git-auth-core.ts `authEnv`), plus no prompts. Without a saved
 * token, only the no-prompt part: git uses whatever credentials the box has, as before.
 */
export async function gitRemoteEnv(slug: string, app: string): Promise<Record<string, string>> {
  const r = await row(slug, app).catch(() => null);
  if (r?.tokenEnc) return { ...NO_PROMPT, ...authEnv(r.remoteUrl, decrypt(r.tokenEnc)) };
  // No saved token, but one written into origin's URL (https://<token>@github.com/…): send that one as a header,
  // since git can't use it from there without prompting.
  const dir = await resolveRepo(slug, app).catch(() => null);
  const url = dir ? await rawOrigin(dir) : null;
  const inUrl = url && tokenInUrl(url);
  if (url && inUrl) return { ...NO_PROMPT, ...authEnv(url, inUrl) };
  return { ...NO_PROMPT };
}

/** origin's URL as it is, credentials and all (never sent to the browser: see currentOrigin). */
async function rawOrigin(repoDir: string): Promise<string | null> {
  try {
    return (await run("git", ["remote", "get-url", "origin"], { cwd: repoDir, timeout: 5000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The repo's `origin` now (credentials masked), or null when it has none. */
export async function currentOrigin(repoDir: string): Promise<string | null> {
  try {
    const url = (await run("git", ["remote", "get-url", "origin"], { cwd: repoDir, timeout: 5000 })).stdout.trim();
    return url ? redactUrl(url) : null;
  } catch {
    return null;
  }
}

/**
 * Save a repo's remote: the URL (normalized, made its `origin`) and, when given, a token
 * (`token: null` forgets the saved one; undefined keeps it). Then checks that the remote
 * answers with it (`git ls-remote`): `check` says how that went, the save stands either way.
 */
export async function saveRemote(
  slug: string,
  app: string,
  repoDir: string,
  input: { remoteUrl: string; token?: string | null },
): Promise<{ saved: SavedRemote; check: { ok: boolean; message: string } }> {
  const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
  const pid = await projectId(slug);
  const prev = await row(slug, app);
  // Nothing typed and nothing saved, but origin has a token written into its URL: keep that one, encrypted,
  // as the URL is cleaned of it below.
  const before = await rawOrigin(repoDir);
  const adopted = input.token === undefined && !prev?.tokenEnc && before ? tokenInUrl(before) : null;
  const token = adopted ?? (input.token === undefined ? undefined : input.token === null ? null : cleanToken(input.token));
  const tokenEnc = token === undefined ? (prev?.tokenEnc ?? null) : token === null ? null : encrypt(token);
  const hint = token === undefined ? (prev?.tokenHint ?? null) : token === null ? null : tokenHint(token);

  const hasOrigin = (await run("git", ["remote"], { cwd: repoDir, timeout: 5000 })).stdout.split("\n").includes("origin");
  await run("git", ["remote", hasOrigin ? "set-url" : "add", "origin", remoteUrl], { cwd: repoDir, timeout: 5000 });

  await db
    .insert(gitCredentials)
    .values({ projectId: pid, app, remoteUrl, tokenEnc, tokenHint: hint, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [gitCredentials.projectId, gitCredentials.app],
      set: { remoteUrl, tokenEnc, tokenHint: hint, updatedAt: new Date() },
    });

  let check: { ok: boolean; message: string };
  try {
    const env = { ...process.env, ...(await gitRemoteEnv(slug, app)) };
    await run("git", ["ls-remote", "--heads", "origin"], { cwd: repoDir, timeout: 20_000, env, maxBuffer: 4 * 1024 * 1024 });
    check = { ok: true, message: tokenEnc ? "GitHub accepted the token" : "The remote answers (without a saved token)" };
  } catch (e) {
    const x = e as { stderr?: string; killed?: boolean };
    const why = x.killed ? "timed out" : (x.stderr ?? "").trim().split("\n").slice(-2).join(" ");
    check = { ok: false, message: why || "the remote didn't answer" };
  }
  return { saved: (await savedRemote(slug, app))!, check };
}

/** Forget a repo's saved remote and token. Its `origin` stays as it is. */
export async function forgetRemote(slug: string, app: string): Promise<void> {
  await db
    .delete(gitCredentials)
    .where(and(eq(gitCredentials.projectId, await projectId(slug)), eq(gitCredentials.app, app)));
}
