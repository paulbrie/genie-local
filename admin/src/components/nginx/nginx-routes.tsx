"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CircleAlert, Globe, Info, Lock, LockOpen, Network, RefreshCw, Rows3, Search, Unplug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import type { RouteSnapshot } from "@/lib/nginx";
import type { AppRow, Problem } from "@/lib/nginx-routes";
import { PortDialog } from "./port-dialog";
import { hostsOf, isLocal, listenOf, listenerName, rowsOf, upstreamText, type RouteRow } from "./route-rows";
import { RoutesDiagram } from "./routes-diagram";
import { SubdomainNotice } from "./subdomain-notice";

const LEVEL_ICON = { error: CircleAlert, warn: AlertTriangle, info: Info } as const;
const LEVEL_COLOR = { error: "text-red-600 dark:text-red-400", warn: "text-amber-600 dark:text-amber-400", info: "text-sky-600 dark:text-sky-400" } as const;
const KIND_LABEL: Record<Problem["kind"], string> = {
  "duplicate-port": "Shared ports",
  "dead-route": "Nothing listening",
  unrouted: "Listening, no route",
  "port-range": "Out of range",
  "duplicate-path": "Duplicate paths",
};

function ProblemIcons({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null;
  return (
    <span className="flex flex-col gap-0.5">
      {problems.map((p, i) => {
        const Icon = LEVEL_ICON[p.level];
        return (
          <span key={i} className={cn("flex items-start gap-1 text-xs", LEVEL_COLOR[p.level])}>
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{p.message}</span>
          </span>
        );
      })}
    </span>
  );
}

function ListenerCell({ row }: { row: RouteRow }) {
  const up = row.route.upstream;
  if (up.kind !== "proxy" || !isLocal(up.host)) return <span className="text-muted-foreground">—</span>;
  const l = row.listener;
  if (!l) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
        <Unplug className="size-3.5" aria-hidden /> nothing listening
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="font-medium">{listenerName(l)}</span>
      <span className="text-xs text-muted-foreground">
        {l.process ?? "not ours"}{l.pid ? ` · pid ${l.pid}` : ""}
      </span>
    </span>
  );
}

/**
 * The Nginx page's Routes view (T242): every server and location as one table
 * (or a diagram), what listens behind each, the admin app it belongs to and its
 * run state, the problems flagged; filter and search; an app's port changed
 * through the generated include only, after a diff preview and the conflict
 * checks. Hand-written files are shown, not edited here (the Files tab edits them).
 */
export function NginxRoutes({ snapshot }: { snapshot: RouteSnapshot }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [source, setSource] = useState<"all" | "generated" | "hand">("all");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [kind, setKind] = useState<Problem["kind"] | null>(null);
  const [view, setView] = useState<"table" | "diagram">("table");
  const [editing, setEditing] = useState<AppRow | null>(null);

  const rows = useMemo(() => rowsOf(snapshot), [snapshot]);
  const counts = useMemo(() => {
    const c = new Map<Problem["kind"], { n: number; level: Problem["level"] }>();
    for (const p of snapshot.problems) {
      const was = c.get(p.kind);
      const rank = { error: 0, warn: 1, info: 2 };
      c.set(p.kind, { n: (was?.n ?? 0) + 1, level: was && rank[was.level] < rank[p.level] ? was.level : p.level });
    }
    return c;
  }, [snapshot.problems]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (source === "generated" && !r.route.generated) return false;
      if (source === "hand" && r.route.generated) return false;
      if (onlyProblems && !r.problems.length) return false;
      if (kind && !r.problems.some((p) => p.kind === kind)) return false;
      if (!needle) return true;
      const hay = [r.route.path, upstreamText(r.route), hostsOf(r.server), listenOf(r.server), r.route.file, r.listener?.process, r.listener?.project, r.listener?.pid, r.app?.project, r.app?.app]
        .join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q, source, onlyProblems, kind]);

  const unrouted = snapshot.problems.filter((p) => p.kind === "unrouted");
  const noPort = snapshot.apps.filter((a) => a.port === null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* the problems, at a glance: each a filter */}
      <div className="flex flex-wrap items-center gap-2">
        {counts.size === 0 ? (
          <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">No problems found</Badge>
        ) : (
          [...counts].map(([k, { n, level }]) => {
            const Icon = LEVEL_ICON[level];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setKind(kind === k ? null : k)}
                aria-pressed={kind === k}
                className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted", kind === k && "bg-muted ring-1 ring-ring", LEVEL_COLOR[level])}
              >
                <Icon className="size-3.5" aria-hidden /> {KIND_LABEL[k]} · {n}
              </button>
            );
          })
        )}
        {!snapshot.generatedInSync && (
          <Badge variant="outline" className="text-amber-700 dark:text-amber-400" title={snapshot.generatedPath}>
            projects.conf differs from the DB: the next port change rewrites it
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <SubdomainNotice enabled={snapshot.subdomainsEnabled} />
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </span>
      </div>

      {snapshot.error && <p className="text-sm text-red-600">{snapshot.error}</p>}

      {/* the servers: names, listen ports, TLS */}
      <div className="flex flex-wrap gap-2">
        {snapshot.servers.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs" title={`${s.file}:${s.line}`}>
            <Globe className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="font-medium">{hostsOf(s)}</span>
            <span className="font-mono text-muted-foreground">{listenOf(s)}</span>
            {s.tls ? (
              <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400"><Lock className="size-3" aria-hidden /> TLS</span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground" title="TLS ends at the gateway in front of this box"><LockOpen className="size-3" aria-hidden /> plain HTTP</span>
            )}
            <span className="text-muted-foreground">· {snapshot.routes.filter((r) => r.serverId === s.id).length} routes</span>
          </div>
        ))}
      </div>

      {/* filter and search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a path, port, process, project…" className="h-8 pl-7 text-sm" aria-label="Search the routes" />
        </div>
        <div role="group" aria-label="Source" className="flex rounded-md border p-0.5 text-xs">
          {(["all", "generated", "hand"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setSource(v)} aria-pressed={source === v} className={cn("rounded px-2 py-1", source === v ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {v === "all" ? "All" : v === "generated" ? "Generated (apps)" : "Hand-written"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Problems only
        </label>
        <span className="text-xs text-muted-foreground">{shown.length} of {rows.length} routes</span>
        <div role="group" aria-label="View" className="ml-auto flex rounded-md border p-0.5 text-xs">
          <button type="button" onClick={() => setView("table")} aria-pressed={view === "table"} className={cn("inline-flex items-center gap-1 rounded px-2 py-1", view === "table" ? "bg-muted font-medium" : "text-muted-foreground")}>
            <Rows3 className="size-3.5" aria-hidden /> Table
          </button>
          <button type="button" onClick={() => setView("diagram")} aria-pressed={view === "diagram"} className={cn("inline-flex items-center gap-1 rounded px-2 py-1", view === "diagram" ? "bg-muted font-medium" : "text-muted-foreground")}>
            <Network className="size-3.5" aria-hidden /> Diagram
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        {view === "diagram" ? (
          <RoutesDiagram rows={shown} />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">Upstream</th>
                <th className="px-3 py-2 font-medium">Listening</th>
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Problems</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.route.id} className={cn("border-b align-top last:border-0", r.problems.some((p) => p.level === "error") && "bg-red-500/5")}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="block">{hostsOf(r.server)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{listenOf(r.server)}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.route.modifier && <span className="text-muted-foreground">{r.route.modifier} </span>}{r.route.path}</td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{upstreamText(r.route)}</td>
                  <td className="px-3 py-2"><ListenerCell row={r} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.app ? (
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot color={r.app.running ? "bg-emerald-500" : "bg-zinc-400"} label={r.app.running ? "running" : "stopped"} />
                        <Link href={`/projects/${r.app.project}`} className="hover:underline">{r.app.project}{r.app.app ? `/${r.app.app}` : ""}</Link>
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.route.generated ? (
                      <Badge variant="secondary" title={r.route.file}>generated · apps.port</Badge>
                    ) : (
                      <span className="text-muted-foreground" title="Hand-written: shown here, edited in the Files tab">hand-written · {r.route.file.replace(/^\/etc\/nginx\//, "")}:{r.route.line}</span>
                    )}
                  </td>
                  <td className="max-w-80 px-3 py-2"><ProblemIcons problems={r.problems} /></td>
                  <td className="px-3 py-2 text-right">
                    {r.route.generated && r.app && (
                      <Button variant="outline" size="sm" onClick={() => setEditing(r.app)}>Port…</Button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-muted-foreground">No route matches.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* what the routes don't show: servers with no route, apps with no port */}
      {(unrouted.length > 0 || noPort.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          {unrouted.length > 0 && (
            <section className="rounded-md border p-3">
              <h2 className="mb-2 text-sm font-medium">Listening, no route</h2>
              <ul className="space-y-1 text-sm">{unrouted.map((p, i) => <li key={i} className={LEVEL_COLOR[p.level]}>{p.message}</li>)}</ul>
            </section>
          )}
          {noPort.length > 0 && (
            <section className="rounded-md border p-3">
              <h2 className="mb-2 text-sm font-medium">Apps with no port (not routed)</h2>
              <ul className="space-y-1 text-sm">
                {noPort.map((a) => (
                  <li key={a.appId} className="flex items-center gap-2">
                    <StatusDot color={a.running ? "bg-emerald-500" : "bg-zinc-400"} label={a.running ? "running" : "stopped"} />
                    <Link href={`/projects/${a.project}`} className="hover:underline">{a.project}{a.app ? `/${a.app}` : ""}</Link>
                    <span className="font-mono text-xs text-muted-foreground">{a.mount}</span>
                    <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setEditing(a)}>Set port…</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {editing && <PortDialog app={editing} onClose={() => setEditing(null)} onApplied={() => { setEditing(null); router.refresh(); }} />}
    </div>
  );
}
