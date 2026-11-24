"use client";

import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASE_PATH } from "@/lib/config";
import { deploymentUrl, stateOf } from "@/lib/railway-core";
import { cn } from "@/lib/utils";

type Link = {
  tokenHint: string | null;
  tokenKind: "account" | "workspace" | "project";
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  collectedUntil: string | null;
  updatedAt: string;
};
type Scopes = {
  kind: "account" | "workspace" | "project";
  user: { name: string | null; email: string } | null;
  workspaces: { id: string; name: string }[];
  fixed: { project: { id: string; name: string }; environment: { id: string; name: string } } | null;
};
type RProject = { id: string; name: string; environments: { id: string; name: string }[]; repos: string[]; matches: boolean };
type Service = { id: string; name: string; source: string | null; latest: { id: string; status: string; created: number } | null; domains: string[] };
type Deployment = {
  id: string; status: string; created: number; service: string | null; serviceId: string | null; url: string | null;
  creator: string | null; branch: string | null; commit: string | null; message: string | null; repo: string | null;
};
type Line = { at: number | null; level?: string; text?: string; method?: string; path?: string; status?: number; ms?: number | null };
type Get = <T>(q: Record<string, string>) => Promise<T>;

const DOT = { ok: "bg-emerald-500", failed: "bg-red-500", busy: "bg-amber-500", off: "bg-zinc-400" } as const;

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const time = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "");

/**
 * A project's Railway tab: the Railway project and environment it shows (with the box's token, or one of its own),
 * its services, its production issues, and its deployments with their build, deploy and HTTP logs.
 */
export function RailwayPanel({ slug, initial, boxToken }: { slug: string; initial: Link | null; boxToken: boolean }) {
  const api = `${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/railway`;
  const get = useCallback(async <T,>(q: Record<string, string>): Promise<T> => {
    const r = await fetch(`${api}?${new URLSearchParams(q)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j as T;
  }, [api]);
  const put = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j.link as Link;
  }, [api]);

  const [link, setLink] = useState<Link | null>(initial);
  // (no token to use yet: the box has none and the project neither)
  const [editingToken, setEditingToken] = useState(!boxToken && !initial?.tokenHint);
  const [picking, setPicking] = useState(!initial?.projectId || !initial?.environmentId);

  if (editingToken) {
    return (
      <TokenForm
        boxToken={boxToken}
        hasOwn={!!link?.tokenHint}
        onCancel={boxToken || link?.tokenHint ? () => setEditingToken(false) : undefined}
        onSave={async (token) => {
          const l = await put({ token });
          setLink(l);
          setEditingToken(false);
          setPicking(!l.projectId || !l.environmentId);
          toast.success(`Railway took it: ${l.tokenKind === "project" ? `a project token, for ${l.projectName} · ${l.environmentName}` : `a${l.tokenKind === "account" ? "n account" : " workspace"} token`}`);
        }}
      />
    );
  }
  if (picking || !link?.projectId || !link.environmentId) {
    return (
      <ProjectPicker
        get={get}
        link={link}
        onCancel={link?.projectId && link.environmentId ? () => setPicking(false) : undefined}
        onOwnToken={() => setEditingToken(true)}
        onPick={async (workspaceId, p, env) => {
          setLink(await put({ workspaceId, projectId: p.id, projectName: p.name, environmentId: env.id, environmentName: env.name }));
          setPicking(false);
        }}
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{link.projectName}</span>
        <Badge variant="outline">{link.environmentName}</Badge>
        <span className="text-muted-foreground">
          on Railway · {link.tokenHint ? `its own ${link.tokenKind} token …${link.tokenHint}` : "the box's token"}
        </span>
        <div className="ml-auto flex gap-1.5">
          {link.tokenKind !== "project" && <Button size="sm" variant="outline" onClick={() => setPicking(true)}>Change project</Button>}
          <Button size="sm" variant="outline" onClick={() => setEditingToken(true)}>
            <KeyRound className="size-3.5" /> {link.tokenHint ? "Replace token" : "Use a token of its own"}
          </Button>
          {link.tokenHint && boxToken && (
            <Button size="sm" variant="ghost" onClick={async () => {
              setLink(await put({ boxToken: true }));
              setPicking(true);
            }}>Use the box&apos;s token</Button>
          )}
          <Button size="sm" variant="ghost" onClick={async () => {
            if (!confirm("Forget this project's Railway link (and its token, if it has one)?")) return;
            await fetch(api, { method: "DELETE" });
            setLink(null);
            setEditingToken(!boxToken);
            setPicking(true);
          }}>Remove</Button>
        </div>
      </div>
      <Services get={get} link={link} />
      <Issues get={get} api={api} slug={slug} />
      <Deployments get={get} link={link} />
    </div>
  );
}

function TokenForm({ boxToken, hasOwn, onSave, onCancel }: { boxToken: boolean; hasOwn: boolean; onSave: (token: string) => Promise<void>; onCancel?: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form className="max-w-xl space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await onSave(token);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <div className="space-y-1.5">
        <Label htmlFor="railway-token">Railway token{boxToken ? " for this project" : ""}</Label>
        <Input id="railway-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus
          placeholder={hasOwn ? "a new token to replace its own" : "from railway.com/account/tokens"} className="font-mono text-xs" />
        <p className="text-xs text-muted-foreground">
          {boxToken
            ? "This box has a Railway token (the Railway explorer's), used when a project has none of its own: give one here for a project in another account or workspace. "
            : "This box has no Railway token (RAILWAY_API_TOKEN), so the project needs its own. "}
          Make one at <a className="underline" href="https://railway.com/account/tokens" target="_blank" rel="noreferrer">railway.com/account/tokens</a>: an
          account or workspace token, or a project token (from the project&apos;s settings), which shows its one environment. It&apos;s checked with
          Railway, stored encrypted, and only ever sent to Railway.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Save"}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

function ProjectPicker({ get, link, onPick, onCancel, onOwnToken }: {
  get: Get;
  link: Link | null;
  onPick: (workspaceId: string | null, p: RProject, env: { id: string; name: string }) => Promise<void>;
  onCancel?: () => void;
  onOwnToken: () => void;
}) {
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(link?.workspaceId ?? null);
  // (the projects, or why not, of the workspace they're for: another one's aren't shown)
  const [found, setFound] = useState<{ key: string | null; projects?: RProject[]; error?: string } | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  useEffect(() => {
    get<Scopes>({ op: "scopes" }).then((s) => {
      setScopes(s);
      setWorkspace((w) => w ?? s.workspaces[0]?.id ?? null);
    }, (e) => setScopeError((e as Error).message));
  }, [get]);

  useEffect(() => {
    if (!scopes || (scopes.kind === "account" && !workspace)) return;
    get<{ projects: RProject[] }>({ op: "projects", ...(scopes.kind === "account" && workspace ? { workspace } : {}) }).then(
      (r) => setFound({ key: workspace, projects: r.projects.sort((a, b) => Number(b.matches) - Number(a.matches) || a.name.localeCompare(b.name)) }),
      (e) => setFound({ key: workspace, error: (e as Error).message }),
    );
  }, [scopes, workspace, get]);
  const mine = found && found.key === workspace ? found : null;
  const projects = mine?.projects ?? null;
  const error = scopeError ?? mine?.error ?? null;

  // (production first: what the tab is mostly for)
  const envs = (p: RProject) => [...p.environments].sort((a, b) => Number(b.name === "production") - Number(a.name === "production") || a.name.localeCompare(b.name));
  return (
    <div className="max-w-2xl space-y-3">
      <div className="text-sm">
        Which Railway project and environment is this?{" "}
        {scopes && (
          <span className="text-muted-foreground">
            ({link?.tokenHint ? "its own token" : "the box's token"}: {scopes.user ? `${scopes.user.name ?? scopes.user.email}'s account` : `a ${scopes.kind} token`})
          </span>
        )}
      </div>
      {scopes && scopes.workspaces.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {scopes.workspaces.map((w) => (
            <Button key={w.id} size="sm" variant={workspace === w.id ? "secondary" : "outline"} onClick={() => setWorkspace(w.id)}>{w.name}</Button>
          ))}
        </div>
      )}
      {error && (
        <div className="space-y-1 text-sm">
          <p className="text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={onOwnToken}><KeyRound className="size-3.5" /> Use a token of its own</Button>
        </div>
      )}
      {!projects && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {projects && projects.length === 0 && <p className="text-sm text-muted-foreground">No projects here.</p>}
      {projects && projects.length > 0 && (
        <div className="divide-y rounded-lg border">
          {projects.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium">{p.name}</span>
              {p.repos.slice(0, 2).map((r) => <span key={r} className="font-mono text-xs text-muted-foreground">{r}</span>)}
              {p.matches && <Badge variant="secondary">this repo</Badge>}
              <span className="ml-auto flex flex-wrap gap-1">
                {envs(p).map((e) => (
                  <Button key={e.id} size="sm" variant="outline" className="h-7" onClick={() => onPick(workspace, p, e).catch((err) => toast.error((err as Error).message))}>
                    {e.name}
                  </Button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        {!error && <Button size="sm" variant="ghost" onClick={onOwnToken}>Use a token of its own…</Button>}
      </div>
    </div>
  );
}

/** The environment's services: each one's latest deployment and where it answers. */
function Services({ get, link }: { get: Get; link: Link }) {
  const [list, setList] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ services: Service[] }>({ op: "services" }).then((r) => setList(r.services), (e) => setError((e as Error).message));
  }, [get, link.projectId, link.environmentId]);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!list) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((s) => {
        const st = s.latest ? stateOf(s.latest.status) : "off";
        return (
          <div key={s.id} className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
            <span className={cn("size-2 shrink-0 rounded-full", DOT[st], st === "busy" && "animate-pulse")} title={s.latest?.status ?? "no deployment"} />
            <span className="font-medium">{s.name}</span>
            <span className="text-xs text-muted-foreground">{s.latest ? `${s.latest.status.toLowerCase()} · ${ago(s.latest.created)}` : "not deployed"}</span>
            {s.domains[0] && (
              <a href={`https://${s.domains[0]}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs hover:underline">
                {s.domains[0]} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

const PAGE_SIZES = [5, 10, 25] as const;
const SIZE_KEY = "admin:railway:page-size";

function Deployments({ get, link }: { get: Get; link: Link }) {
  const [list, setList] = useState<Deployment[] | null>(null);
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  const [service, setService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [size, setSize] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(SIZE_KEY));
      return (PAGE_SIZES as readonly number[]).includes(n) ? n : 5;
    } catch {
      return 5;
    }
  });
  // (pages by cursor: cursors[i] is page i's `after`; the first page has none)
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    get<{ services: Service[] }>({ op: "services" }).then((r) => setServices(r.services.map((s) => ({ id: s.id, name: s.name }))), () => {});
  }, [get]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const after = cursors[page];
      const r = await get<{ deployments: Deployment[]; next: string | null }>({
        op: "deployments",
        limit: String(size),
        ...(after ? { after } : {}),
        ...(service ? { service } : {}),
      });
      setList(r.deployments);
      setNext(r.next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [get, size, cursors, page, service]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  // (while one is under way, look again every 15 s: on the first page, where new ones show)
  const busy = page === 0 && !!list?.some((d) => stateOf(d.status) === "busy");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [busy, load]);

  const restart = () => {
    setCursors([null]);
    setPage(0);
  };
  const pickSize = (n: number) => {
    setSize(n);
    restart();
    try {
      localStorage.setItem(SIZE_KEY, String(n));
    } catch {
      /* not remembered */
    }
  };
  const shown = list?.find((d) => d.id === open) ?? null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
        <Button size="sm" variant="ghost" className="h-7" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        {services.length > 1 && (
          <div className="ml-auto flex flex-wrap gap-1 text-xs">
            <Button size="sm" variant={service === null ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => { setService(null); restart(); }}>All</Button>
            {services.map((s) => (
              <Button key={s.id} size="sm" variant={service === s.id ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => { setService(s.id); restart(); }}>{s.name}</Button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!list && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list && list.length === 0 && <p className="text-sm text-muted-foreground">{page === 0 ? "No deployments yet." : "No older deployments."}</p>}
      {list && list.length > 0 && (
        <div className="divide-y rounded-lg border text-sm">
          {list.map((d) => {
            const st = stateOf(d.status);
            return (
              <button key={d.id} onClick={() => setOpen(open === d.id ? null : d.id)}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50", open === d.id && "bg-muted/50")}>
                <span className={cn("size-2 shrink-0 rounded-full", DOT[st], st === "busy" && "animate-pulse")} title={d.status} />
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{d.status.toLowerCase()}</span>
                {d.service && <Badge variant="outline">{d.service}</Badge>}
                <span className="min-w-0 flex-1 truncate">
                  {d.message ?? d.url ?? d.id}
                  {d.branch && <span className="ml-2 font-mono text-xs text-muted-foreground">{d.branch}{d.commit ? ` · ${d.commit}` : ""}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(d.created)}{d.creator ? ` · ${d.creator}` : ""}</span>
              </button>
            );
          })}
        </div>
      )}
      {list && (page > 0 || next != null || list.length > 0) && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Per page</span>
          {PAGE_SIZES.map((n) => (
            <Button key={n} size="sm" variant={size === n ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => pickSize(n)}>{n}</Button>
          ))}
          <span className="ml-auto text-muted-foreground">page {page + 1}</span>
          <Button size="sm" variant="outline" className="h-7" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>← Newer</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={next == null || loading} onClick={() => {
            if (next == null) return;
            setCursors((c) => [...c.slice(0, page + 1), next]);
            setPage((p) => p + 1);
          }}>Older →</Button>
        </div>
      )}
      {shown && <Logs key={shown.id} d={shown} get={get} link={link} />}
    </div>
  );
}

/**
 * A deployment's logs: its build, what its service prints, the requests it answered. Railway keeps them, so they load
 * at once; Live looks again every 10 s for what's new (opt-in: every look counts against Railway's hourly limit).
 */
function Logs({ d, get, link }: { d: Deployment; get: Get; link: Link }) {
  const [tab, setTab] = useState<"build" | "deploy" | "http">(stateOf(d.status) === "failed" && d.status === "FAILED" ? "build" : "deploy");
  // (the lines of the tab they're for: another tab's aren't shown while this one loads)
  const [got, setGot] = useState<{ tab: string; lines: Line[] } | null>(null);
  const lines = got?.tab === tab ? got.lines : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await get<{ lines: Line[] }>({ op: tab, deployment: d.id });
      setGot({ tab, lines: r.lines });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [get, tab, d.id]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  // Live: what came after the last line, every 10 s
  useEffect(() => {
    if (!live || tab === "build") return;
    const t = setInterval(async () => {
      const last = lines?.at(-1)?.at ?? Date.now() - 60_000;
      try {
        const r = await get<{ lines: Line[] }>({ op: tab, deployment: d.id, since: String(last + 1) });
        if (r.lines.length) setGot((g) => (g?.tab === tab ? { tab, lines: [...g.lines, ...r.lines].slice(-2000) } : g));
      } catch (e) {
        setError((e as Error).message);
        setLive(false);
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [live, tab, d.id, get, lines]);

  const red = (l: Line) => l.level === "error" || (l.status ?? 0) >= 500;
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
        {(["build", "deploy", "http"] as const).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? "secondary" : "ghost"} onClick={() => setTab(t)}>
            {t === "build" ? "Build logs" : t === "deploy" ? "Deploy logs" : "HTTP logs"}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="h-7" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        {tab !== "build" && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Look for new lines every 10 s (each look counts against Railway's hourly limit)">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            {live ? <span className="flex items-center gap-1 text-emerald-600"><span className="size-2 animate-pulse rounded-full bg-emerald-500" /> Live</span> : "Live"}
          </label>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs">
          {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{d.url.replace("https://", "")} <ExternalLink className="size-3" /></a>}
          {link.projectId && link.environmentId && (
            <a href={deploymentUrl(link.projectId, d.serviceId, link.environmentId, d.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              On Railway <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
      {error && <p className="px-3 py-2 text-sm text-destructive">{error}</p>}
      <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines === null
          ? loading ? "Loading…" : ""
          : lines.length === 0
            ? tab === "build" ? "(no build output)" : tab === "deploy" ? "(nothing printed yet)" : "(no requests in the last day)"
            : lines.map((l, i) => (
              <div key={i} className={cn(red(l) && "text-red-600 dark:text-red-400", (l.level === "warn" || l.level === "warning") && "text-amber-600")}>
                <span className="text-muted-foreground">{time(l.at)} </span>
                {tab === "http" ? `${l.method} ${l.path} ${l.status}${l.ms != null ? ` · ${l.ms} ms` : ""}` : l.text}
              </div>
            ))}
      </pre>
    </div>
  );
}

type Issue = {
  id: number; kind: "runtime" | "build" | "crash"; level: "error" | "warning"; title: string; sample: string;
  recent: { at?: number; path?: string | null; method?: string | null; status?: number | null; service?: string }[];
  paths: string[]; services: string[]; count: number; firstSeen: string; lastSeen: string; lastDeploymentId: string | null; taskId: number | null; dismissedAt: string | null;
};
type Collector = {
  running: boolean;
  everyMs: number;
  project: { lastRun: number | null; lines: number; problems: number; services: number; error: string | null } | null;
  lastTick: number | null;
  pausedUntil: number | null;
  error: string | null;
} | null;

/**
 * Production's errors and warnings, failed builds and crashed deployments, read from Railway's logs every few minutes
 * by the live admin (src/lib/railway-collector.ts), grouped, newest first: each one a ticket away.
 */
function Issues({ get, api, slug }: { get: Get; api: string; slug: string }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [collector, setCollector] = useState<Collector>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<"error" | "warning" | "all">("all");
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ issues: Issue[]; collector: Collector }>({ op: "issues", ...(dismissed ? { dismissed: "1" } : {}) });
      setIssues(r.issues);
      setCollector(r.collector);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [get, dismissed]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const act = async (action: "ticket" | "dismiss" | "restore", id: number) => {
    setBusy(id);
    try {
      const r = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (action === "ticket") toast.success(`Ticket #${j.taskId} created in Tasks`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const shown = (issues ?? []).filter((i) => level === "all" || i.level === level);
  const errors = (issues ?? []).filter((i) => i.level === "error" && !i.dismissedAt).length;
  const warnings = (issues ?? []).filter((i) => i.level === "warning" && !i.dismissedAt).length;
  const p = collector?.project;
  const tasksHref = (id: number) => `${BASE_PATH}/projects/${encodeURIComponent(slug)}/tasks?task=${id}`;
  const every = collector ? Math.round(collector.everyMs / 60_000) : 5;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Production issues</h2>
        {issues && (
          <span className="text-xs text-muted-foreground">
            {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs">
          {(["all", "error", "warning"] as const).map((l) => (
            <Button key={l} size="sm" variant={level === l ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setLevel(l)}>
              {l === "all" ? "All" : l === "error" ? "Errors" : "Warnings"}
            </Button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={dismissed} onChange={(e) => setDismissed(e.target.checked)} /> dismissed
          </label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {collector === null
          ? "Read by the live admin (this instance doesn't): problems show here a few minutes after they happen."
          : collector.pausedUntil
            ? `Paused until ${new Date(collector.pausedUntil).toLocaleTimeString()}: Railway asked to slow down.`
            : p?.error
              ? `The last look failed: ${p.error}`
              : p?.lastRun
                ? `Read from Railway's logs every ${every} minutes (last ${new Date(p.lastRun).toLocaleTimeString()}, ${p.services} service${p.services === 1 ? "" : "s"}) · ${p.problems} problem line${p.problems === 1 ? "" : "s"} since the admin started.`
                : `Read from Railway's logs every ${every} minutes; the first look reaches back a day.`}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {issues && shown.length === 0 && (
        <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
          {issues.length === 0 ? "No problems seen in production yet." : "None of this kind."}
        </p>
      )}
      {shown.length > 0 && (
        <div className="divide-y rounded-lg border text-sm">
          {shown.map((i) => (
            <div key={i.id} className={cn(i.dismissedAt && "opacity-60")}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === i.id ? null : i.id)}>
                  <span className={cn("size-2 shrink-0 rounded-full", i.level === "error" ? "bg-red-500" : "bg-amber-500")} title={i.level} />
                  {i.kind !== "runtime" && <Badge variant="outline">{i.kind}</Badge>}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{i.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {i.kind === "runtime" ? `×${i.count} · ` : ""}{ago(new Date(i.lastSeen).getTime())}
                    {i.services.length > 0 && ` · ${i.services.join(", ")}`}
                    {i.paths.length > 0 && ` · ${i.paths.slice(0, 2).join(", ")}${i.paths.length > 2 ? "…" : ""}`}
                  </span>
                </button>
                {i.taskId ? (
                  <a href={tasksHref(i.taskId)} className="shrink-0 text-xs font-medium hover:underline">Ticket #{i.taskId}</a>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={busy === i.id} onClick={() => act("ticket", i.id)}>Create ticket</Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" disabled={busy === i.id} onClick={() => act(i.dismissedAt ? "restore" : "dismiss", i.id)}>
                  {i.dismissedAt ? "Restore" : "Dismiss"}
                </Button>
              </div>
              {open === i.id && (
                <div className="space-y-2 border-t bg-muted/30 px-3 py-2 text-xs">
                  <div className="text-muted-foreground">
                    {i.kind === "runtime"
                      ? `${i.count} time${i.count === 1 ? "" : "s"} · first ${new Date(i.firstSeen).toLocaleString()} · last ${new Date(i.lastSeen).toLocaleString()}`
                      : `${i.kind === "build" ? "Build" : "Crash"} of ${new Date(i.firstSeen).toLocaleString()}`}
                    {i.lastDeploymentId && ` · ${i.lastDeploymentId}`}
                  </div>
                  <pre className="max-h-72 overflow-auto rounded bg-background p-2 font-mono whitespace-pre-wrap">{i.sample || "(no message)"}</pre>
                  {i.kind === "runtime" && i.recent.length > 0 && (
                    <div>
                      <div className="text-muted-foreground">Recent:</div>
                      {i.recent.map((r, k) => (
                        <div key={k} className="font-mono">
                          {r.at ? new Date(r.at).toLocaleString() : ""} {r.service ?? ""} {r.method ?? ""} {r.path ?? ""} {r.status ?? ""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
