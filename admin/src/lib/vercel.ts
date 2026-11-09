import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { projectVercel } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { getProjectIdBySlug } from "@/lib/data";
import { listRepos } from "@/lib/git-graph";

// A project's Vercel tab: its token (stored encrypted, only ever sent to api.vercel.com), the team and Vercel
// project it shows, and what Vercel's REST API says about them: deployments, build logs, runtime logs.

const API = "https://api.vercel.com";
const run = promisify(execFile);

export type VercelLink = { hasToken: true; tokenHint: string; teamId: string | null; projectId: string | null; projectName: string | null; updatedAt: Date };

async function projectId(slug: string): Promise<number> {
  const id = await getProjectIdBySlug(slug);
  if (id === null) throw new Error(`no project ${slug}`);
  return id;
}

async function row(slug: string) {
  const [r] = await db.select().from(projectVercel).where(eq(projectVercel.projectId, await projectId(slug)));
  return r ?? null;
}

/** What the tab shows about the link (never the token). */
export async function vercelLink(slug: string): Promise<VercelLink | null> {
  const r = await row(slug);
  return r ? { hasToken: true, tokenHint: r.tokenHint, teamId: r.teamId, projectId: r.vercelProjectId, projectName: r.vercelProjectName, updatedAt: r.updatedAt } : null;
}

export class VercelError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** A call to Vercel's API with `token`, in `teamId`'s scope when given. */
async function call<T>(token: string, path: string, teamId: string | null, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  if (teamId) u.searchParams.set("teamId", teamId);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  if (!res.ok) {
    const why = body.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new VercelError(`Vercel refused the token: ${why}`, 403);
    throw new VercelError(`Vercel: ${why}`, res.status === 404 ? 404 : 502);
  }
  return body as T;
}

async function linked(slug: string) {
  const r = await row(slug);
  if (!r) throw new VercelError("no Vercel token saved for this project", 404);
  return { token: decrypt(r.tokenEnc), teamId: r.teamId, projectId: r.vercelProjectId };
}

/**
 * The account a token belongs to (null for a team's own token, which has no user: Vercel answers "user not found"),
 * and the teams it can work in. Throws when Vercel takes it for neither.
 */
async function whoAndTeams(token: string) {
  const [user, teams] = await Promise.all([
    call<{ user: { username: string; email?: string; defaultTeamId?: string | null } }>(token, "/v2/user", null).then(
      ({ user: u }) => ({ username: u.username, email: u.email ?? null, defaultTeamId: u.defaultTeamId ?? null }),
      (e: Error) => e,
    ),
    call<{ teams: { id: string; slug: string; name: string }[] }>(token, "/v2/teams", null, { limit: 100 }).then(
      (t) => t.teams.map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
      (e: Error) => e,
    ),
  ]);
  if (user instanceof Error && teams instanceof Error) throw user;
  return { user: user instanceof Error ? null : user, teams: teams instanceof Error ? [] : teams };
}

/**
 * Save the link: a new token (checked with Vercel first) and/or the team and project it shows. Leaving the token
 * out keeps the saved one.
 */
export async function saveVercel(
  slug: string,
  input: { token?: string; teamId?: string | null; projectId?: string | null; projectName?: string | null },
): Promise<VercelLink> {
  const pid = await projectId(slug);
  const prev = await row(slug);
  const token = input.token?.trim();
  if (token !== undefined && token !== "") {
    if (/\s/.test(token) || token.length > 500) throw new VercelError("that doesn't look like a Vercel token", 400);
    await whoAndTeams(token);
  } else if (!prev) {
    throw new VercelError("a Vercel token is needed", 400);
  }
  const tokenEnc = token ? encrypt(token) : prev!.tokenEnc;
  const tokenHint = token ? token.slice(-4) : prev!.tokenHint;
  // (a new team means the project has to be picked again, unless given with it)
  const teamId = input.teamId !== undefined ? input.teamId || null : (prev?.teamId ?? null);
  const teamChanged = input.teamId !== undefined && teamId !== (prev?.teamId ?? null);
  const vercelProjectId = input.projectId !== undefined ? input.projectId || null : teamChanged ? null : (prev?.vercelProjectId ?? null);
  const vercelProjectName = input.projectName !== undefined ? input.projectName || null : teamChanged ? null : (prev?.vercelProjectName ?? null);
  const values = { tokenEnc, tokenHint, teamId, vercelProjectId, vercelProjectName, updatedAt: new Date() };
  await db.insert(projectVercel).values({ projectId: pid, ...values }).onConflictDoUpdate({ target: projectVercel.projectId, set: values });
  return (await vercelLink(slug))!;
}

export async function forgetVercel(slug: string): Promise<void> {
  await db.delete(projectVercel).where(eq(projectVercel.projectId, await projectId(slug)));
}

/** The saved token's account and teams (to pick the scope). */
export async function vercelScopes(slug: string) {
  return whoAndTeams((await linked(slug)).token);
}

/** "owner/repo" of a project's git origin on GitHub, to recognise its Vercel project. */
async function originRepo(slug: string): Promise<string | null> {
  const repo = (await listRepos(slug).catch(() => []))[0];
  if (!repo) return null;
  try {
    const url = (await run("git", ["remote", "get-url", "origin"], { cwd: repo.path, timeout: 5000 })).stdout.trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The team's (or account's) Vercel projects; `matches` marks the one deploying this project's GitHub repo. */
export async function vercelProjects(slug: string, search?: string) {
  const { token, teamId } = await linked(slug);
  const [r, repo] = await Promise.all([
    call<{ projects: { id: string; name: string; framework?: string | null; link?: { type?: string; org?: string; repo?: string } }[] }>(token, "/v9/projects", teamId, { limit: 100, search }),
    originRepo(slug),
  ]);
  return r.projects.map((p) => {
    const linkedRepo = p.link?.org && p.link.repo ? `${p.link.org}/${p.link.repo}` : null;
    return { id: p.id, name: p.name, framework: p.framework ?? null, repo: linkedRepo, matches: !!repo && linkedRepo?.toLowerCase() === repo };
  });
}

type RawDeployment = {
  uid: string;
  name: string;
  url: string;
  created: number;
  state?: string;
  readyState?: string;
  target?: string | null;
  inspectorUrl?: string;
  creator?: { username?: string };
  meta?: Record<string, string | undefined>;
  buildingAt?: number;
  ready?: number;
};

/** The project's latest deployments, newest first. */
export async function vercelDeployments(slug: string, limit = 20) {
  const { token, teamId, projectId: vp } = await linked(slug);
  if (!vp) throw new VercelError("pick the Vercel project first", 400);
  const r = await call<{ deployments: RawDeployment[] }>(token, "/v6/deployments", teamId, { projectId: vp, limit });
  return r.deployments.map((d) => ({
    id: d.uid,
    url: d.url ? `https://${d.url}` : null,
    state: d.readyState ?? d.state ?? "UNKNOWN",
    target: d.target ?? "preview",
    created: d.created,
    buildMs: d.ready && d.buildingAt ? d.ready - d.buildingAt : null,
    creator: d.creator?.username ?? null,
    branch: d.meta?.githubCommitRef ?? d.meta?.gitlabCommitRef ?? d.meta?.bitbucketCommitRef ?? null,
    commit: d.meta?.githubCommitSha?.slice(0, 7) ?? null,
    message: (d.meta?.githubCommitMessage ?? d.meta?.gitlabCommitMessage ?? "").split("\n")[0] || null,
    inspectorUrl: d.inspectorUrl ?? null,
  }));
}

/** A deployment's build log: one line per event (stdout, stderr, the commands it ran). */
export async function vercelBuildLogs(slug: string, deploymentId: string) {
  const { token, teamId } = await linked(slug);
  const events = await call<{ type?: string; created?: number; text?: string; payload?: { text?: string; date?: number } }[]>(
    token,
    `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
    teamId,
    { limit: -1, builds: 1, direction: "forward" },
  );
  return (Array.isArray(events) ? events : [])
    .map((e) => ({ at: e.payload?.date ?? e.created ?? null, type: e.type ?? "stdout", text: e.payload?.text ?? e.text ?? "" }))
    .filter((e) => e.text);
}

/**
 * A deployment's recent runtime logs (requests and what the functions printed). Vercel streams them; this reads for
 * up to `ms` and returns what came (newest last).
 */
export async function vercelRuntimeLogs(slug: string, deploymentId: string, ms = 4000) {
  const { token, teamId, projectId: vp } = await linked(slug);
  if (!vp) throw new VercelError("pick the Vercel project first", 400);
  const u = new URL(`${API}/v1/projects/${encodeURIComponent(vp)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`);
  if (teamId) u.searchParams.set("teamId", teamId);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const lines: { at: number | null; level: string; source: string | null; text: string; method: string | null; path: string | null; status: number | null }[] = [];
  try {
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new VercelError(`Vercel: ${body.error?.message ?? `HTTP ${res.status}`}`, res.status === 401 || res.status === 403 ? 403 : 502);
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (lines.length < 2000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as { timestampInMs?: number; level?: string; source?: string; message?: string; requestMethod?: string; requestPath?: string; responseStatusCode?: number };
          lines.push({ at: l.timestampInMs ?? null, level: l.level ?? "info", source: l.source ?? null, text: l.message ?? "", method: l.requestMethod ?? null, path: l.requestPath ?? null, status: l.responseStatusCode ?? null });
        } catch {
          /* a partial or odd line */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return lines;
}
