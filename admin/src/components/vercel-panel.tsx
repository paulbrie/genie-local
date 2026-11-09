"use client";

import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";

type Link = { hasToken: true; tokenHint: string; teamId: string | null; projectId: string | null; projectName: string | null; updatedAt: string };
type Scopes = { user: { username: string; email: string | null; defaultTeamId: string | null }; teams: { id: string; slug: string; name: string }[] };
type VProject = { id: string; name: string; framework: string | null; repo: string | null; matches: boolean };
type Deployment = {
  id: string; url: string | null; state: string; target: string; created: number; buildMs: number | null;
  creator: string | null; branch: string | null; commit: string | null; message: string | null; inspectorUrl: string | null;
};
type BuildLine = { at: number | null; type: string; text: string };
type RuntimeLine = { at: number | null; level: string; source: string | null; text: string; method: string | null; path: string | null; status: number | null };

const STATE: Record<string, string> = {
  READY: "bg-emerald-500", ERROR: "bg-red-500", CANCELED: "bg-zinc-400",
  BUILDING: "bg-amber-500", INITIALIZING: "bg-amber-500", QUEUED: "bg-amber-500",
};
const busyState = (s: string) => ["BUILDING", "INITIALIZING", "QUEUED"].includes(s);

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const time = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "");

/** A project's Vercel tab: its token, the Vercel project it shows, deployments, build and runtime logs. */
export function VercelPanel({ slug, initial }: { slug: string; initial: Link | null }) {
  const api = `${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/vercel`;
  const get = useCallback(async <T,>(q: Record<string, string>): Promise<T> => {
    const r = await fetch(`${api}?${new URLSearchParams(q)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j as T;
  }, [api]);
  const put = async (body: Record<string, unknown>) => {
    const r = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j.link as Link;
  };

  const [link, setLink] = useState<Link | null>(initial);
  const [editingToken, setEditingToken] = useState(!initial);
  const [picking, setPicking] = useState(!!initial && !initial.projectId);

  if (!link || editingToken) {
    return <TokenForm hasToken={!!link} onCancel={link ? () => setEditingToken(false) : undefined} onSave={async (token) => {
      const l = await put({ token });
      setLink(l);
      setEditingToken(false);
      setPicking(!l.projectId);
      toast.success("Vercel accepted the token");
    }} />;
  }
  if (picking || !link.projectId) {
    return <ProjectPicker get={get} link={link} saveTeam={async (teamId) => { await put({ teamId }); }} onCancel={link.projectId ? () => setPicking(false) : undefined} onPick={async (teamId, p) => {
      setLink(await put({ teamId, projectId: p.id, projectName: p.name }));
      setPicking(false);
    }} />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{link.projectName}</span>
        <span className="text-muted-foreground">on Vercel · token …{link.tokenHint}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>Change project</Button>
          <Button size="sm" variant="outline" onClick={() => setEditingToken(true)}><KeyRound className="size-3.5" /> Replace token</Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            if (!confirm("Forget this project's Vercel token and link?")) return;
            await fetch(api, { method: "DELETE" });
            setLink(null);
            setEditingToken(true);
          }}>Remove</Button>
        </div>
      </div>
      <Deployments get={get} />
    </div>
  );
}

function TokenForm({ hasToken, onSave, onCancel }: { hasToken: boolean; onSave: (token: string) => Promise<void>; onCancel?: () => void }) {
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
        <Label htmlFor="vercel-token">Vercel token</Label>
        <Input id="vercel-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus
          placeholder={hasToken ? "a new token to replace the saved one" : "from vercel.com/account/tokens"} className="font-mono text-xs" />
        <p className="text-xs text-muted-foreground">
          Make one at <a className="underline" href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer">vercel.com/account/tokens</a>,
          scoped to the team the project is in. It&apos;s checked with Vercel, stored encrypted, and only ever sent to Vercel.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Save"}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

function ProjectPicker({ get, link, saveTeam, onPick, onCancel }: {
  get: <T>(q: Record<string, string>) => Promise<T>;
  link: Link;
  /** the projects listed are the saved team's: a team picked here is saved first */
  saveTeam: (teamId: string | null) => Promise<void>;
  onPick: (teamId: string | null, p: VProject) => Promise<void>;
  onCancel?: () => void;
}) {
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [team, setTeam] = useState<string | null>(link.teamId);
  const [projects, setProjects] = useState<VProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Scopes>({ op: "scopes" }).then((s) => {
      setScopes(s);
      // (no team picked yet: the account's default team, else the only team, else the personal account)
      setTeam((t) => t ?? s.user.defaultTeamId ?? (s.teams.length === 1 ? s.teams[0].id : null));
    }, (e) => setError((e as Error).message));
  }, [get]);

  // (the list is per scope: the server reads the team from the saved link, so a team change is saved first)
  const [scopeSaved, setScopeSaved] = useState(link.teamId);
  useEffect(() => {
    if (!scopes) return;
    let live = true;
    const load = async () => {
      setProjects(null);
      setError(null);
      try {
        if (team !== scopeSaved) {
          await saveTeam(team);
          setScopeSaved(team);
        }
        const r = await get<{ projects: VProject[] }>({ op: "projects" });
        if (live) setProjects(r.projects.sort((a, b) => Number(b.matches) - Number(a.matches) || a.name.localeCompare(b.name)));
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [scopes, team, scopeSaved, get, saveTeam]);

  return (
    <div className="max-w-2xl space-y-3">
      <div className="text-sm">
        Which Vercel project is this?{" "}
        {scopes && <span className="text-muted-foreground">(token of {scopes.user.username})</span>}
      </div>
      {scopes && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={team === null ? "secondary" : "outline"} onClick={() => setTeam(null)}>{scopes.user.username} (personal)</Button>
          {scopes.teams.map((t) => (
            <Button key={t.id} size="sm" variant={team === t.id ? "secondary" : "outline"} onClick={() => setTeam(t.id)}>{t.name}</Button>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!projects && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {projects && projects.length === 0 && <p className="text-sm text-muted-foreground">No projects in this scope.</p>}
      {projects && (
        <div className="divide-y rounded-lg border">
          {projects.map((p) => (
            <button key={p.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => onPick(team, p).catch((e) => toast.error((e as Error).message))}>
              <span className="font-medium">{p.name}</span>
              {p.repo && <span className="font-mono text-xs text-muted-foreground">{p.repo}</span>}
              {p.matches && <Badge variant="secondary">this repo</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">{p.framework ?? ""}</span>
            </button>
          ))}
        </div>
      )}
      {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
    </div>
  );
}

function Deployments({ get }: { get: <T>(q: Record<string, string>) => Promise<T> }) {
  const [list, setList] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList((await get<{ deployments: Deployment[] }>({ op: "deployments" })).deployments);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  // (while one builds, look again every 10 s)
  const building = !!list?.some((d) => busyState(d.state));
  useEffect(() => {
    if (!building) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [building, load]);

  const shown = list?.find((d) => d.id === open) ?? null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
        <Button size="sm" variant="ghost" className="h-7" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!list && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list && list.length === 0 && <p className="text-sm text-muted-foreground">No deployments yet.</p>}
      {list && list.length > 0 && (
        <div className="divide-y rounded-lg border text-sm">
          {list.map((d) => (
            <button key={d.id} onClick={() => setOpen(open === d.id ? null : d.id)}
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50", open === d.id && "bg-muted/50")}>
              <span className={cn("size-2 shrink-0 rounded-full", STATE[d.state] ?? "bg-zinc-400", busyState(d.state) && "animate-pulse")} title={d.state} />
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{d.state.toLowerCase()}</span>
              {d.target === "production" ? <Badge>production</Badge> : <Badge variant="outline">preview</Badge>}
              <span className="min-w-0 flex-1 truncate">
                {d.message ?? d.url ?? d.id}
                {d.branch && <span className="ml-2 font-mono text-xs text-muted-foreground">{d.branch}{d.commit ? ` · ${d.commit}` : ""}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {d.buildMs ? `${Math.round(d.buildMs / 1000)}s · ` : ""}{ago(d.created)}{d.creator ? ` · ${d.creator}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {shown && <Logs key={shown.id} d={shown} get={get} />}
    </div>
  );
}

function Logs({ d, get }: { d: Deployment; get: <T>(q: Record<string, string>) => Promise<T> }) {
  const [tab, setTab] = useState<"build" | "runtime">("build");
  const [build, setBuild] = useState<BuildLine[] | null>(null);
  const [runtime, setRuntime] = useState<RuntimeLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (which: "build" | "runtime") => {
    setLoading(true);
    setError(null);
    try {
      const r = await get<{ lines: BuildLine[] | RuntimeLine[] }>({ op: which, deployment: d.id });
      if (which === "build") setBuild(r.lines as BuildLine[]);
      else setRuntime(r.lines as RuntimeLine[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [get, d.id]);

  useEffect(() => {
    const t = setTimeout(() => load("build"), 0);
    return () => clearTimeout(t);
  }, [load]);
  // (a build still running: its log grows)
  useEffect(() => {
    if (tab !== "build" || !busyState(d.state)) return;
    const t = setInterval(() => load("build"), 5000);
    return () => clearInterval(t);
  }, [tab, d.state, load]);

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
        <Button size="sm" variant={tab === "build" ? "secondary" : "ghost"} onClick={() => { setTab("build"); load("build"); }}>Build logs</Button>
        <Button size="sm" variant={tab === "runtime" ? "secondary" : "ghost"} onClick={() => { setTab("runtime"); load("runtime"); }}>Runtime logs</Button>
        {loading && <span className="text-xs text-muted-foreground">{tab === "runtime" ? "Listening a few seconds…" : "Loading…"}</span>}
        <div className="ml-auto flex items-center gap-3 text-xs">
          {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{d.url.replace("https://", "")} <ExternalLink className="size-3" /></a>}
          {d.inspectorUrl && <a href={d.inspectorUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">On Vercel <ExternalLink className="size-3" /></a>}
        </div>
      </div>
      {error && <p className="px-3 py-2 text-sm text-destructive">{error}</p>}
      <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {tab === "build" &&
          (build === null ? "" : build.length === 0 ? "(no build output)" : build.map((l, i) => (
            <div key={i} className={cn(l.type === "stderr" && "text-red-600 dark:text-red-400", l.type === "command" && "text-muted-foreground")}>
              <span className="text-muted-foreground">{time(l.at)} </span>{l.text}
            </div>
          )))}
        {tab === "runtime" &&
          (runtime === null ? "" : runtime.length === 0 ? "(nothing logged recently: requests and function output show here as they come)" : runtime.map((l, i) => (
            <div key={i} className={cn((l.level === "error" || (l.status ?? 0) >= 500) && "text-red-600 dark:text-red-400", l.level === "warning" && "text-amber-600")}>
              <span className="text-muted-foreground">{time(l.at)} </span>
              {l.method && <span>{l.method} {l.path} {l.status ?? ""} </span>}
              {l.text}
            </div>
          )))}
      </pre>
    </div>
  );
}
