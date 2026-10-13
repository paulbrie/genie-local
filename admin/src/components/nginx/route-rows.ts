/**
 * The Nginx routes page's rows (T242): each route with its server, what listens
 * behind it and its admin app, and the words for them; shared by the table and
 * the diagram.
 */
import type { RouteSnapshot } from "@/lib/nginx";
import type { AppRow, ListenerInfo, Problem, Route, ServerInfo } from "@/lib/nginx-routes";

/** A route, told: its server, what listens behind it, its admin app, its problems. */
export type RouteRow = { route: Route; server: ServerInfo; listener: ListenerInfo | null; app: AppRow | null; problems: Problem[] };

export const isLocal = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "0.0.0.0";

/** the local port a route proxies to, if it does */
export function localPortOf(r: Route): number | null {
  return r.upstream.kind === "proxy" && isLocal(r.upstream.host) ? r.upstream.port : null;
}

export function rowsOf(s: RouteSnapshot): RouteRow[] {
  const servers = new Map(s.servers.map((x) => [x.id, x]));
  const byPort = new Map(s.listeners.map((l) => [l.port, l]));
  return s.routes.map((route) => {
    const port = localPortOf(route);
    const app =
      (route.generated ? s.apps.find((a) => a.mount === route.path) : null) ??
      (port !== null ? s.apps.find((a) => a.port === port && route.path.startsWith(a.mount)) ?? null : null);
    return {
      route,
      server: servers.get(route.serverId)!,
      listener: port !== null ? byPort.get(port) ?? null : null,
      app,
      problems: s.problems.filter((p) => p.routeIds?.includes(route.id)),
    };
  });
}

export const hostsOf = (s: ServerInfo) => (s.names.length === 0 || (s.names.length === 1 && s.names[0] === "_") ? "any host" : s.names.filter((n) => n !== "_").join(" "));
export const listenOf = (s: ServerInfo) => [...new Set(s.listen.map((l) => `:${l.port}${l.ssl ? " ssl" : ""}`))].join(" ");

export function upstreamText(r: Route): string {
  const u = r.upstream;
  switch (u.kind) {
    case "proxy": return isLocal(u.host) ? `:${u.port}${u.uri}` : `${u.scheme}://${u.host}${u.port === (u.scheme === "https" ? 443 : 80) ? "" : `:${u.port}`}${u.uri}`;
    case "socket": return `unix:${u.path}`;
    case "redirect": return `${u.status} → ${u.to}`;
    case "static": return `files ${u.root}`;
    case "internal": return "internal";
    default: return u.raw || "—";
  }
}


export { listenerDetail, listenerName } from "@/lib/nginx-routes";
