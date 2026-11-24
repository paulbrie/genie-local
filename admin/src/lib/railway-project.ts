import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { projectRailway, projects } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { getProjectIdBySlug } from "@/lib/data";
import { listRepos } from "@/lib/git-graph";
import { railwayToken } from "@/lib/railway";
import { deploymentMeta, lastN, logLine, logWindow, repoKey, type RawHttpLog, type RawLog } from "@/lib/railway-core";

// A project's Railway tab: the Railway project and environment it shows, and what Railway's GraphQL API says about
// them: services, deployments, build, deploy and HTTP logs. It uses the box's token (RAILWAY_API_TOKEN, the one the
// Railway explorer, src/lib/railway.ts, uses) unless the project has one of its own (stored encrypted, only ever sent
// to Railway's API). Railway's limits are tight (100 requests an hour on its free plan, 1000 on Hobby), so nothing
// here polls by itself.

const API = "https://backboard.railway.com/graphql/v2";
const run = promisify(execFile);

export type TokenKind = "account" | "workspace" | "project";
export type RailwayLink = {
  /** the project's own token (its last 4), else null: the box's */
  tokenHint: string | null;
  tokenKind: TokenKind;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  collectedUntil: Date | null;
  updatedAt: Date;
};

export class RailwayApiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const LOG = "timestamp message severity attributes { key value }";

/** Every query the tab and its collector send (exported to check them against Railway's schema). */
export const Q = {
  projectToken: `query { projectToken { project { id name workspaceId } environment { id name } } }`,
  me: `query { me { name email workspaces { id name } } }`,
  workspaceProjects: `query($w: String!) { workspace(workspaceId: $w) { projects(first: 100) { edges { node { ...P } } } } }
    fragment P on Project { id name environments { edges { node { id name serviceInstances { edges { node { serviceName source { repo } } } } } } } }`,
  projects: `query { projects(first: 100) { edges { node { ...P } } } }
    fragment P on Project { id name environments { edges { node { id name serviceInstances { edges { node { serviceName source { repo } } } } } } } }`,
  services: `query($env: String!, $project: String!) { environment(id: $env, projectId: $project) { serviceInstances { edges { node {
    serviceId serviceName source { repo image } latestDeployment { id status createdAt staticUrl snapshotId }
    domains { serviceDomains { domain } customDomains { domain } } } } } } }`,
  deployments: `query($input: DeploymentListInput!, $first: Int, $after: String) { deployments(input: $input, first: $first, after: $after) {
    edges { node { id status createdAt staticUrl url serviceId snapshotId environmentId projectId meta creator { name email } service { name } } }
    pageInfo { hasNextPage endCursor } } }`,
  deployment: `query($id: String!) { deployment(id: $id) { id status createdAt snapshotId environmentId serviceId projectId } }`,
  environmentLogs: `query($environmentId: String!, $filter: String, $beforeLimit: Int, $beforeDate: String, $anchorDate: String, $afterDate: String, $afterLimit: Int) {
    environmentLogs(environmentId: $environmentId, filter: $filter, beforeLimit: $beforeLimit, beforeDate: $beforeDate, anchorDate: $anchorDate, afterDate: $afterDate, afterLimit: $afterLimit) { ${LOG} } }`,
  buildLogs: `query($deploymentId: String!, $limit: Int) { buildLogs(deploymentId: $deploymentId, limit: $limit) { ${LOG} } }`,
  deploymentLogs: `query($deploymentId: String!, $limit: Int, $filter: String, $startDate: DateTime, $endDate: DateTime) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter, startDate: $startDate, endDate: $endDate) { ${LOG} } }`,
  httpLogs: `query($deploymentId: String!, $filter: String, $beforeLimit: Int!, $beforeDate: String, $anchorDate: String, $afterDate: String, $afterLimit: Int) {
    httpLogs(deploymentId: $deploymentId, filter: $filter, beforeLimit: $beforeLimit, beforeDate: $beforeDate, anchorDate: $anchorDate, afterDate: $afterDate, afterLimit: $afterLimit) {
      timestamp method path httpStatus totalDuration upstreamErrors } }`,
} as const;

/** A call to Railway's API with `token`, sent as its kind wants (a project token in its own header). */
export async function gql<T>(token: string, kind: TokenKind, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const auth: Record<string, string> = kind === "project" ? { "Project-Access-Token": token } : { Authorization: `Bearer ${token}` };
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (res.status === 429) {
    const after = res.headers.get("Retry-After");
    throw new RailwayApiError(`Railway's rate limit for this token is used up${after ? `: try again in ${after} s` : ""}`, 429);
  }
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length) {
    const why = body.errors.map((e) => e.message ?? "").filter(Boolean).join("; ") || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403 || /not authori[sz]ed|unauthori[sz]ed|invalid.*token|forbidden/i.test(why)) {
      throw new RailwayApiError(`Railway refused the token: ${why}`, 403);
    }
    throw new RailwayApiError(`Railway: ${why}`, /not found/i.test(why) ? 404 : 502);
  }
  if (!res.ok || !body.data) throw new RailwayApiError(`Railway: HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 403 : 502);
  return body.data;
}

async function projectId(slug: string): Promise<number> {
  const id = await getProjectIdBySlug(slug);
  if (id === null) throw new Error(`no project ${slug}`);
  return id;
}

async function row(slug: string) {
  const [r] = await db.select().from(projectRailway).where(eq(projectRailway.projectId, await projectId(slug)));
  return r ?? null;
}

/** Whether the box has a Railway token of its own (RAILWAY_API_TOKEN), for projects without one. */
export const hasBoxToken = () => railwayToken() !== null;

/** What the tab shows about the link (never the token). */
export async function railwayLink(slug: string): Promise<RailwayLink | null> {
  const r = await row(slug);
  return r
    ? {
        tokenHint: r.tokenEnc ? r.tokenHint : null,
        tokenKind: r.tokenEnc ? (r.tokenKind as TokenKind) : "account",
        workspaceId: r.workspaceId,
        projectId: r.railwayProjectId,
        projectName: r.railwayProjectName,
        environmentId: r.environmentId,
        environmentName: r.environmentName,
        collectedUntil: r.collectedUntil,
        updatedAt: r.updatedAt,
      }
    : null;
}

/** The token a link works with: the project's own, else the box's (an account's). */
function tokenOf(r: { tokenEnc: string | null; tokenKind: string | null }): { token: string; kind: TokenKind } {
  if (r.tokenEnc) return { token: decrypt(r.tokenEnc), kind: (r.tokenKind as TokenKind) ?? "account" };
  const box = railwayToken();
  if (!box) throw new RailwayApiError("no Railway token: give this project one, or set RAILWAY_API_TOKEN for the whole box", 400);
  return { token: box, kind: "account" };
}

async function linked(slug: string) {
  const r = await row(slug);
  // (not linked yet: the box's token, to pick the project with)
  if (!r) return { ...tokenOf({ tokenEnc: null, tokenKind: null }), workspaceId: null, projectId: null, environmentId: null };
  return { ...tokenOf(r), workspaceId: r.workspaceId, projectId: r.railwayProjectId, environmentId: r.environmentId };
}

type Scopes = {
  kind: TokenKind;
  user: { name: string | null; email: string } | null;
  workspaces: { id: string; name: string }[];
  /** a project token's one project and environment */
  fixed: { project: { id: string; name: string; workspaceId: string | null }; environment: { id: string; name: string } } | null;
};

/** What a token is (Railway has three kinds, which it doesn't say), with what it can see. Throws when it's none. */
async function detect(token: string): Promise<Scopes> {
  const asProject = await gql<{ projectToken: { project: { id: string; name: string; workspaceId: string | null }; environment: { id: string; name: string } } }>(
    token,
    "project",
    Q.projectToken,
  ).then((r) => r.projectToken, (e: Error) => e);
  if (!(asProject instanceof Error)) return { kind: "project", user: null, workspaces: [], fixed: asProject };
  const asAccount = await gql<{ me: { name: string | null; email: string; workspaces: { id: string; name: string }[] } }>(token, "account", Q.me).then((r) => r.me, (e: Error) => e);
  if (!(asAccount instanceof Error)) return { kind: "account", user: { name: asAccount.name, email: asAccount.email }, workspaces: asAccount.workspaces, fixed: null };
  const asWorkspace = await gql<unknown>(token, "workspace", Q.projects).then(() => null, (e: Error) => e);
  if (!asWorkspace) return { kind: "workspace", user: null, workspaces: [], fixed: null };
  if (asAccount instanceof RailwayApiError && asAccount.status === 429) throw asAccount;
  throw new RailwayApiError(`Railway takes this for none of its tokens (an account's, a workspace's or a project's): ${asWorkspace.message.replace(/^Railway( refused the token)?: /, "")}`, 403);
}

/**
 * Save the link: a token of the project's own (checked with Railway first; `boxToken` drops it for the box's) and/or
 * the workspace, project and environment it shows. Leaving the token out keeps what it had. A project token comes with
 * its project and environment.
 */
export async function saveRailway(
  slug: string,
  input: {
    token?: string;
    boxToken?: boolean;
    workspaceId?: string | null;
    projectId?: string | null;
    projectName?: string | null;
    environmentId?: string | null;
    environmentName?: string | null;
  },
): Promise<RailwayLink> {
  const pid = await projectId(slug);
  const prev = await row(slug);
  const token = input.token?.trim();
  let scopes: Scopes | null = null;
  if (token !== undefined && token !== "") {
    if (/\s/.test(token) || token.length > 500) throw new RailwayApiError("that doesn't look like a Railway token", 400);
    scopes = await detect(token);
  } else if ((input.boxToken || !prev?.tokenEnc) && !railwayToken()) {
    throw new RailwayApiError("this box has no Railway token (RAILWAY_API_TOKEN): give this project one", 400);
  }
  // (back to the box's token: the project is picked again)
  if (input.boxToken && !token) scopes = { kind: "account", user: null, workspaces: [], fixed: null };
  const own = token ? token : input.boxToken ? null : (prev?.tokenEnc ?? null);
  const tokenKind = scopes?.kind ?? ((prev?.tokenKind as TokenKind | null) ?? "account");
  const keep = <K extends keyof typeof input>(k: K, was: string | null | undefined) => (input[k] !== undefined ? (input[k] as string | null) || null : (was ?? null));
  // (a new token or another workspace: the project is picked again, unless given with it)
  const fresh = !!scopes || (input.workspaceId !== undefined && (input.workspaceId || null) !== (prev?.workspaceId ?? null));
  const values = {
    tokenEnc: token ? encrypt(token) : own,
    tokenHint: token ? token.slice(-4) : own ? prev!.tokenHint : null,
    tokenKind: own ? tokenKind : null,
    workspaceId: scopes?.fixed?.project.workspaceId ?? keep("workspaceId", fresh && scopes ? null : prev?.workspaceId),
    railwayProjectId: scopes?.fixed?.project.id ?? keep("projectId", fresh ? null : prev?.railwayProjectId),
    railwayProjectName: scopes?.fixed?.project.name ?? keep("projectName", fresh ? null : prev?.railwayProjectName),
    environmentId: scopes?.fixed?.environment.id ?? keep("environmentId", fresh ? null : prev?.environmentId),
    environmentName: scopes?.fixed?.environment.name ?? keep("environmentName", fresh ? null : prev?.environmentName),
    updatedAt: new Date(),
  };
  // (another project or environment: its logs are read afresh)
  const moved = values.railwayProjectId !== (prev?.railwayProjectId ?? null) || values.environmentId !== (prev?.environmentId ?? null);
  await db
    .insert(projectRailway)
    .values({ projectId: pid, ...values })
    .onConflictDoUpdate({ target: projectRailway.projectId, set: { ...values, ...(moved ? { collectedUntil: null } : {}) } });
  return (await railwayLink(slug))!;
}

export async function forgetRailway(slug: string): Promise<void> {
  await db.delete(projectRailway).where(eq(projectRailway.projectId, await projectId(slug)));
}

/** The token's kind and what it can see (to pick the workspace): the project's own, else the box's. */
export async function railwayScopes(slug: string): Promise<Scopes> {
  return detect((await linked(slug)).token);
}

/** "owner/repo" of a project's git origin, to recognise its Railway project. */
async function originRepo(slug: string): Promise<string | null> {
  const repo = (await listRepos(slug).catch(() => []))[0];
  if (!repo) return null;
  try {
    return repoKey((await run("git", ["remote", "get-url", "origin"], { cwd: repo.path, timeout: 5000 })).stdout);
  } catch {
    return null;
  }
}

type RawProject = {
  id: string;
  name: string;
  environments: { edges: { node: { id: string; name: string; serviceInstances: { edges: { node: { serviceName: string; source: { repo: string | null } | null } }[] } } }[] };
};

/** The workspace's Railway projects with their environments; `matches` marks one with a service deploying this repo. */
export async function railwayProjects(slug: string, workspaceId: string | null) {
  const { token, kind } = await linked(slug);
  const [raw, repo] = await Promise.all([
    kind === "account"
      ? workspaceId
        ? gql<{ workspace: { projects: { edges: { node: RawProject }[] } } }>(token, kind, Q.workspaceProjects, { w: workspaceId }).then((r) => r.workspace.projects.edges)
        : Promise.resolve([])
      : gql<{ projects: { edges: { node: RawProject }[] } }>(token, kind, Q.projects).then((r) => r.projects.edges),
    originRepo(slug),
  ]);
  return raw.map(({ node: p }) => {
    const repos = new Set(p.environments.edges.flatMap((e) => e.node.serviceInstances.edges.map((s) => repoKey(s.node.source?.repo)).filter((r): r is string => !!r)));
    return {
      id: p.id,
      name: p.name,
      environments: p.environments.edges.map((e) => ({ id: e.node.id, name: e.node.name })),
      repos: [...repos],
      matches: !!repo && repos.has(repo),
    };
  });
}

async function picked(slug: string) {
  const l = await linked(slug);
  if (!l.projectId || !l.environmentId) throw new RailwayApiError("pick the Railway project and environment first", 400);
  return l as typeof l & { projectId: string; environmentId: string };
}

type RawInstance = {
  serviceId: string;
  serviceName: string;
  source: { repo: string | null; image: string | null } | null;
  latestDeployment: { id: string; status: string; createdAt: string; staticUrl: string | null; snapshotId: string | null } | null;
  domains: { serviceDomains: { domain: string }[]; customDomains: { domain: string }[] };
};

/** The environment's services, each with its latest deployment and its domains (custom ones first). */
export async function railwayServicesOf(token: string, kind: TokenKind, projectId: string, environmentId: string) {
  const r = await gql<{ environment: { serviceInstances: { edges: { node: RawInstance }[] } } }>(token, kind, Q.services, { env: environmentId, project: projectId });
  return r.environment.serviceInstances.edges.map(({ node: s }) => ({
    id: s.serviceId,
    name: s.serviceName,
    source: s.source?.repo ?? s.source?.image ?? null,
    latest: s.latestDeployment ? { id: s.latestDeployment.id, status: s.latestDeployment.status, created: Date.parse(s.latestDeployment.createdAt), snapshotId: s.latestDeployment.snapshotId } : null,
    domains: [...s.domains.customDomains.map((d) => d.domain), ...s.domains.serviceDomains.map((d) => d.domain)],
  }));
}

export async function railwayServices(slug: string) {
  const { token, kind, projectId: p, environmentId: e } = await picked(slug);
  return railwayServicesOf(token, kind, p, e);
}

type RawDeployment = {
  id: string;
  status: string;
  createdAt: string;
  staticUrl: string | null;
  url: string | null;
  serviceId: string | null;
  snapshotId: string | null;
  environmentId: string;
  projectId: string;
  meta: unknown;
  creator: { name: string | null; email: string } | null;
  service: { name: string } | null;
};

/** A page of the environment's deployments (one service's, or all), newest first, and the cursor of the page after. */
export async function railwayDeployments(slug: string, limit = 5, after?: string, serviceId?: string) {
  const { token, kind, projectId: p, environmentId: e } = await picked(slug);
  const r = await gql<{ deployments: { edges: { node: RawDeployment }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(token, kind, Q.deployments, {
    input: { projectId: p, environmentId: e, ...(serviceId ? { serviceId } : {}) },
    first: Math.min(Math.max(limit, 1), 50),
    after: after || undefined,
  });
  return {
    deployments: r.deployments.edges.map(({ node: d }) => ({
      id: d.id,
      status: d.status,
      created: Date.parse(d.createdAt),
      service: d.service?.name ?? null,
      serviceId: d.serviceId,
      url: d.staticUrl ? `https://${d.staticUrl}` : d.url,
      creator: d.creator?.name ?? d.creator?.email ?? null,
      ...deploymentMeta(d.meta),
    })),
    next: r.deployments.pageInfo.hasNextPage ? r.deployments.pageInfo.endCursor : null,
  };
}

/** A deployment of the linked project (else refused: the token may see more than this project). */
async function deploymentOf(slug: string, deploymentId: string) {
  const l = await picked(slug);
  const { deployment: d } = await gql<{ deployment: { id: string; status: string; createdAt: string; snapshotId: string | null; environmentId: string; serviceId: string | null; projectId: string } }>(
    l.token,
    l.kind,
    Q.deployment,
    { id: deploymentId },
  );
  if (d.projectId !== l.projectId) throw new RailwayApiError("that deployment isn't this project's", 404);
  return { l, d };
}

/** Build lines of a deployment: its build snapshot's lines in the environment's logs, as Railway's CLI reads them. */
export async function buildLogsOf(token: string, kind: TokenKind, d: { id: string; createdAt: string; snapshotId: string | null; environmentId: string }, limit = 1000) {
  if (!d.snapshotId) {
    const r = await gql<{ buildLogs: RawLog[] }>(token, kind, Q.buildLogs, { deploymentId: d.id, limit });
    return lastN(r.buildLogs, limit).map(logLine);
  }
  const start = new Date(Date.parse(d.createdAt) - 5 * 60_000);
  const r = await gql<{ environmentLogs: RawLog[] }>(token, kind, Q.environmentLogs, {
    environmentId: d.environmentId,
    filter: `(@snapshot:${d.snapshotId} OR @replica:${d.snapshotId})`,
    ...logWindow(start, new Date(), limit),
  });
  return lastN(r.environmentLogs, limit).map(logLine);
}

export async function railwayBuildLogs(slug: string, deploymentId: string) {
  const { l, d } = await deploymentOf(slug, deploymentId);
  return buildLogsOf(l.token, l.kind, d);
}

/** A deployment's own logs (what its service prints): the latest `limit`, or those after `since` (ms). */
export async function deployLogsOf(token: string, kind: TokenKind, deploymentId: string, o: { limit?: number; filter?: string; since?: number; until?: number } = {}) {
  const limit = o.limit ?? 500;
  const r = await gql<{ deploymentLogs: RawLog[] }>(token, kind, Q.deploymentLogs, {
    deploymentId,
    limit,
    filter: o.filter,
    startDate: o.since ? new Date(o.since).toISOString() : undefined,
    endDate: o.until ? new Date(o.until).toISOString() : undefined,
  });
  return lastN(r.deploymentLogs, limit).map(logLine);
}

export async function railwayDeployLogs(slug: string, deploymentId: string, since?: number) {
  const { l } = await deploymentOf(slug, deploymentId);
  return deployLogsOf(l.token, l.kind, deploymentId, { since });
}

/** The requests a deployment answered between `start` and `end` (ms): the latest `limit`, each with status and time. */
export async function httpLogsOf(token: string, kind: TokenKind, deploymentId: string, start: number, end: number, filter?: string, limit = 300) {
  const r = await gql<{ httpLogs: RawHttpLog[] }>(token, kind, Q.httpLogs, { deploymentId, filter, ...logWindow(new Date(start), new Date(end), limit) });
  return lastN(r.httpLogs, limit);
}

export async function railwayHttpLogs(slug: string, deploymentId: string, since?: number) {
  const { l } = await deploymentOf(slug, deploymentId);
  const rows = await httpLogsOf(l.token, l.kind, deploymentId, since ?? Date.now() - 24 * 3600_000, Date.now());
  return rows.map((h) => ({ at: Date.parse(h.timestamp) || null, method: h.method, path: h.path, status: h.httpStatus, ms: h.totalDuration ?? null }));
}

/** Every project with a Railway project and environment picked, for the collector: with its token. */
export async function railwayLinks() {
  const rows = await db
    .select({ r: projectRailway, slug: projects.slug })
    .from(projectRailway)
    .innerJoin(projects, eq(projects.id, projectRailway.projectId));
  return rows
    .filter(({ r }) => r.railwayProjectId && r.environmentId && (r.tokenEnc || railwayToken()))
    .map(({ r, slug }) => ({
      projectId: r.projectId,
      slug,
      ...tokenOf(r),
      railwayProjectId: r.railwayProjectId!,
      railwayProjectName: r.railwayProjectName,
      environmentId: r.environmentId!,
      collectedUntil: r.collectedUntil,
    }));
}

/** The collector has read the project's logs up to `at`. */
export async function setCollectedUntil(projectId: number, at: Date) {
  await db.update(projectRailway).set({ collectedUntil: at }).where(eq(projectRailway.projectId, projectId));
}
