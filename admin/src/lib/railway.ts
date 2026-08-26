import "server-only";

/**
 * Minimal read-only client for Railway's public GraphQL API. The admin app uses
 * it to surface every project in the connected workspace, drill into a service's
 * deployments, and tail deployment logs — which can then be handed to an agent
 * for discovery (see the `railway-discovery` agent).
 *
 * Auth: an ACCOUNT-scoped API token in `RAILWAY_API_TOKEN` (the same token the
 * `railway` MCP server consumes — see /opt/project/.mcp.json and admin/.env.local),
 * sent as `Authorization: Bearer <token>`. Everything here is read-only: we never
 * mutate (deploy/scale/remove), matching the philosophy of the railway-logs agent.
 */

const ENDPOINT =
  process.env.RAILWAY_API_URL ?? "https://backboard.railway.com/graphql/v2";

// Railway log queries can be slow for wide windows; keep a bounded timeout.
const REQUEST_TIMEOUT_MS = 30_000;

export function railwayToken(): string | null {
  const t = process.env.RAILWAY_API_TOKEN?.trim();
  return t ? t : null;
}

export function railwayConfigured(): boolean {
  return railwayToken() != null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type RailwayEnvironment = { id: string; name: string };
export type RailwayService = { id: string; name: string };

export type RailwayProject = {
  id: string;
  name: string;
  services: RailwayService[];
  environments: RailwayEnvironment[];
};

export type RailwayDeployment = {
  id: string;
  status: string; // SUCCESS | FAILED | CRASHED | REMOVED | DEPLOYING | …
  createdAt: string;
  staticUrl: string | null;
};

export type RailwayLogLine = {
  timestamp: string;
  message: string;
  severity: string | null;
};

// ── GraphQL plumbing ─────────────────────────────────────────────────────────

/** A GraphQL error surfaced to the caller (kept distinct so routes can 502 it). */
export class RailwayError extends Error {}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = railwayToken();
  if (!token) throw new RailwayError("RAILWAY_API_TOKEN is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "request timed out" : (e as Error).message;
    throw new RailwayError(`Railway request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: { message: string }[];
  } | null;

  if (!body) throw new RailwayError(`Railway returned ${res.status} with no JSON`);
  if (body.errors?.length) {
    // Surface the first error verbatim (e.g. "Not Authorized" → bad/expired token).
    throw new RailwayError(body.errors.map((e) => e.message).join("; "));
  }
  if (body.data == null) throw new RailwayError("Railway returned no data");
  return body.data;
}

type Connection<T> = { edges: { node: T }[] };
const nodes = <T>(c: Connection<T> | null | undefined): T[] =>
  c?.edges?.map((e) => e.node) ?? [];

// ── Queries ──────────────────────────────────────────────────────────────────

const PROJECTS_QUERY = /* GraphQL */ `
  query AdminProjects {
    projects {
      edges {
        node {
          id
          name
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        }
      }
    }
  }
`;

type ProjectsResponse = {
  projects: Connection<{
    id: string;
    name: string;
    services: Connection<RailwayService>;
    environments: Connection<RailwayEnvironment>;
  }>;
};

/** Every project the token can see, with its services and environments. */
export async function listProjects(): Promise<RailwayProject[]> {
  const data = await gql<ProjectsResponse>(PROJECTS_QUERY);
  const projects = nodes(data.projects).map((p) => ({
    id: p.id,
    name: p.name,
    services: nodes(p.services).sort((a, b) => a.name.localeCompare(b.name)),
    environments: nodes(p.environments).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

const DEPLOYMENTS_QUERY = /* GraphQL */ `
  query AdminDeployments($environmentId: String!, $serviceId: String!) {
    deployments(
      first: 15
      input: { environmentId: $environmentId, serviceId: $serviceId }
    ) {
      edges { node { id status createdAt staticUrl } }
    }
  }
`;

type DeploymentsResponse = { deployments: Connection<RailwayDeployment> };

/** Recent deployments for a service in an environment, newest first. */
export async function listDeployments(
  environmentId: string,
  serviceId: string,
): Promise<RailwayDeployment[]> {
  const data = await gql<DeploymentsResponse>(DEPLOYMENTS_QUERY, {
    environmentId,
    serviceId,
  });
  return nodes(data.deployments);
}

const LOGS_QUERY = /* GraphQL */ `
  query AdminDeploymentLogs($deploymentId: String!, $limit: Int!, $filter: String) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
      timestamp
      message
      severity
    }
  }
`;

type LogsResponse = { deploymentLogs: RailwayLogLine[] };

export const MAX_LOG_LINES = 2000;
export const DEFAULT_LOG_LINES = 500;

/**
 * Logs for one deployment (build/deploy/runtime combined, oldest→newest as
 * Railway returns them). `filter` is Railway's own log-filter syntax (e.g.
 * `@level:error` or a substring); pass null for everything.
 */
export async function getDeploymentLogs(
  deploymentId: string,
  limit: number = DEFAULT_LOG_LINES,
  filter: string | null = null,
): Promise<RailwayLogLine[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_LOG_LINES);
  const data = await gql<LogsResponse>(LOGS_QUERY, {
    deploymentId,
    limit: capped,
    filter: filter && filter.trim() ? filter.trim() : null,
  });
  return data.deploymentLogs ?? [];
}
