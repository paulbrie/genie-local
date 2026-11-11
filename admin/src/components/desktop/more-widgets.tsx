"use client";

import { ArrowDown, ArrowUp, Check, Container, Cpu, GitBranch, Gauge, HeartPulse, KeyRound, ListTodo, Server, TriangleAlert } from "lucide-react";

import { ago, Empty, ROW, Subhead, useOpenPath, usePolled, useWidgetView, ViewSwitch, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { StatusDot } from "@/components/ui/status-dot";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import { formatBytes } from "@/lib/format";
import type { SystemStats } from "@/lib/stats";
import { cn } from "@/lib/utils";
import type { HealthItem, HealthState, RepoState } from "@/lib/widgets-core";

// The desktop's widgets that start off (a right-click on the desktop adds them): Health, Production errors, Git,
// Load, Tickets and Sign-ins. Each a glance, polling /api/widgets/<id> (Load: /api/stats), its rows opening the page
// with the rest.

const DOT: Record<HealthState, { color: string; label: string; pulse?: boolean }> = {
  down: { color: "bg-red-500", label: "Down", pulse: true },
  warn: { color: "bg-amber-500", label: "Starting" },
  ok: { color: "bg-emerald-500", label: "Up" },
  off: { color: "bg-muted-foreground/30", label: "Stopped" },
};

/** Health: the curated services and the containers, what's down first; a row opens Services or Docker. */
export function HealthWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ items: HealthItem[] }>("/api/widgets/health", 20_000);
  const open = useOpenPath();
  const items = data?.items ?? [];
  const live = items.filter((i) => i.state !== "off");
  const down = items.filter((i) => i.state === "down").length;
  const warn = items.filter((i) => i.state === "warn").length;
  return (
    <>
      <WidgetHeader
        id="health"
        icon={HeartPulse}
        title="Health"
        count={data ? `${live.length - down - warn}/${live.length}` : null}
        note={!data ? (failed ? "couldn't read" : "") : down ? `${down} down` : warn ? `${warn} starting` : "all running"}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the services." : "Loading…"}</Empty>}
          {items.map((i) => {
            const d = DOT[i.state];
            const Icon = i.kind === "service" ? Server : Container;
            return (
              <button
                key={`${i.kind}:${i.name}`}
                type="button"
                onClick={() => open(i.kind === "service" ? "/services" : "/docker")}
                title={`${i.name} (${i.kind}): ${i.detail}`}
                className={cn(ROW, i.state === "off" && "opacity-60")}
              >
                <StatusDot color={d.color} pulse={d.pulse} size="sm" label={d.label} />
                <span className="min-w-0 truncate">{i.name}</span>
                {/* (what's wrong when it is; a container's uptime; nothing more for a service that's simply up) */}
                <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 text-[10px] opacity-70">
                  <Icon className="size-2.5 shrink-0" />
                  {i.state === "down" || i.state === "warn"
                    ? i.detail.split(" ").slice(0, 2).join(" ")
                    : i.kind === "container" && i.state === "ok"
                      ? i.detail.replace(/^Up /, "").replace(/ \(healthy\)$/, "")
                      : null}
                </span>
              </button>
            );
          })}
        </WidgetList>
      )}
    </>
  );
}

type Issue = { id: number; slug: string; title: string; level: string; kind: string; count: number; lastSeen: string };

/** Production errors: the open Vercel issues seen this week, the latest first; a row opens its project's Vercel tab. */
export function ErrorsWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ issues: Issue[] }>("/api/widgets/errors", 60_000);
  const open = useOpenPath();
  const issues = data?.issues ?? [];
  const projects = new Set(issues.map((i) => i.slug)).size;
  return (
    <>
      <WidgetHeader
        id="errors"
        icon={TriangleAlert}
        title="Errors"
        count={data ? issues.length : null}
        note={!data ? (failed ? "couldn't read" : "") : issues.length ? `${projects} project${projects === 1 ? "" : "s"} · latest ${ago(issues[0].lastSeen)}` : "none this week"}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the issues." : "Loading…"}</Empty>}
          {data && !issues.length && <Empty>No open production errors this week.</Empty>}
          {issues.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => open(`/projects/${encodeURIComponent(i.slug)}/vercel`)}
              title={`${i.slug}: ${i.title} (${i.kind} ${i.level}, ${i.count}×, last ${ago(i.lastSeen)})`}
              className={ROW}
            >
              <StatusDot color={i.level === "error" ? "bg-red-500" : "bg-amber-500"} size="sm" label={i.level} />
              <span className="shrink-0 opacity-70">{i.slug}</span>
              <span className="min-w-0 truncate text-foreground/90">{i.title}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums opacity-70">{i.count}×</span>
            </button>
          ))}
        </WidgetList>
      )}
    </>
  );
}

type Repo = RepoState & { slug: string; app: string };
const needsYou = (r: Repo) => r.changed + r.untracked > 0 || r.ahead > 0 || r.behind > 0;

/** Git: the repos with changes, commits to push or to pull first, then how many are clean; a row opens its Git tab. */
export function GitWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ repos: Repo[]; total: number }>("/api/widgets/git", 30_000);
  const open = useOpenPath();
  const repos = data?.repos ?? [];
  const busy = repos.filter(needsYou);
  const unpushed = repos.filter((r) => r.ahead > 0).length;
  const dirty = repos.filter((r) => r.changed + r.untracked > 0).length;
  return (
    <>
      <WidgetHeader
        id="git"
        icon={GitBranch}
        title="Git"
        count={data ? busy.length : null}
        note={
          !data
            ? failed
              ? "couldn't read"
              : ""
            : busy.length
              ? [unpushed ? `${unpushed} to push` : null, dirty ? `${dirty} with changes` : null].filter(Boolean).join(" · ") || "behind upstream"
              : "all clean"
        }
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the repos." : "Loading…"}</Empty>}
          {busy.map((r) => (
            <button
              key={`${r.slug}/${r.app}`}
              type="button"
              onClick={() => open(`/projects/${encodeURIComponent(r.slug)}/git`)}
              title={`${r.slug}${r.app ? `/${r.app}` : ""} on ${r.branch ?? "a detached HEAD"}: ${r.changed} changed, ${r.untracked} untracked, ${r.ahead} to push, ${r.behind} to pull`}
              className={ROW}
            >
              <GitBranch className="size-3 shrink-0 opacity-60" />
              <span className="min-w-0 truncate">
                {r.slug}
                {r.app && <span className="opacity-60">/{r.app}</span>}
              </span>
              <span className="min-w-0 truncate text-[10px] opacity-50">{r.branch ?? "detached"}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                {r.changed + r.untracked > 0 && <span className="text-amber-600 dark:text-amber-400">●{r.changed + r.untracked}</span>}
                {r.ahead > 0 && <span className="text-sky-600 dark:text-sky-400">↑{r.ahead}</span>}
                {r.behind > 0 && <span className="text-violet-600 dark:text-violet-400">↓{r.behind}</span>}
              </span>
            </button>
          ))}
          {data && <Empty>{busy.length ? `${repos.length - busy.length} more clean.` : `All ${repos.length} repos clean and pushed.`}</Empty>}
        </WidgetList>
      )}
    </>
  );
}

type HistoryPoint = { t: number; cpu: number; mem: number };

/** Load: CPU and memory over the last day, and the network now and over the last minutes, each a sparkline. */
export function LoadWidget({ folded }: { folded: boolean }) {
  const { data: hist } = usePolled<{ points: HistoryPoint[] }>("/api/stats/history?range=1d", 120_000);
  const { data: now, failed } = usePolled<SystemStats>("/api/stats", 5000);
  const points = hist?.points ?? [];
  const net = now?.net;
  // (compact: the widget's line is narrow)
  const rate = (bps: number) => `${formatBytes(bps).replace(" ", "")}/s`;
  return (
    <>
      <WidgetHeader
        id="load"
        icon={Gauge}
        title="Load"
        count={now ? `${Math.round(now.cpuPercent)}%` : null}
        note={now ? `mem ${Math.round(now.memPercent)}%${net ? ` · ↓ ${rate(net.inBps)}` : ""}` : failed ? "couldn't read" : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!now && <Empty>{failed ? "Couldn't read the stats." : "Loading…"}</Empty>}
          {now && (
            <>
              <Spark label="CPU" value={`${Math.round(now.cpuPercent)}%`} series={[...points.map((p) => p.cpu), now.cpuPercent]} max={100} color="text-sky-500" span="24 h" />
              <Spark label="Memory" value={`${Math.round(now.memPercent)}%`} series={[...points.map((p) => p.mem), now.memPercent]} max={100} color="text-violet-500" span="24 h" />
              {net && (
                <Spark
                  label="Network"
                  value={
                    <span className="flex items-center gap-1.5">
                      <span className="flex items-center">
                        <ArrowDown className="size-2.5" />
                        {rate(net.inBps)}
                      </span>
                      <span className="flex items-center opacity-70">
                        <ArrowUp className="size-2.5" />
                        {rate(net.outBps)}
                      </span>
                    </span>
                  }
                  series={net.history.map((s) => s.inBps)}
                  second={net.history.map((s) => s.outBps)}
                  color="text-teal-500"
                  span="now"
                />
              )}
            </>
          )}
        </WidgetList>
      )}
    </>
  );
}

/** One measure as a label, its value now, and a sparkline of its past (an area; `second`, a fainter line over it). */
function Spark({
  label,
  value,
  series,
  second,
  max,
  color,
  span,
}: {
  label: string;
  value: React.ReactNode;
  series: number[];
  second?: number[];
  max?: number;
  color: string;
  span: string;
}) {
  const W = 200;
  const H = 30;
  const top = max ?? Math.max(1, ...series, ...(second ?? []));
  const path = (s: number[]) =>
    s.map((v, i) => `${((i / Math.max(1, s.length - 1)) * W).toFixed(1)},${(H - (Math.min(v, top) / top) * (H - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <div className="flex flex-col gap-0.5 pt-1 pr-2 pb-1.5 pl-7 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground/60">{span}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">{value}</span>
      </div>
      {series.length > 1 ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("h-7 w-full overflow-visible", color)} aria-hidden>
          <polygon points={`0,${H} ${path(series)} ${W},${H}`} fill="currentColor" opacity="0.12" />
          <polyline points={path(series)} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {second && second.length > 1 && (
            <polyline points={path(second)} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.45" strokeDasharray="2 2" />
          )}
        </svg>
      ) : (
        <div className="h-7" />
      )}
    </div>
  );
}

type Ticket = { id: number; slug: string; title: string; status: string; assignee: string | null };
type DoneTicket = Ticket & { at: string };

/** Tickets: what's in progress (and who has it), then what's to do, across the projects, then the last ones done; a row opens the ticket. */
export function TicketsWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ inProgress: number; open: number; tasks: Ticket[]; done: DoneTicket[] }>("/api/widgets/tickets", 30_000);
  const open = useOpenPath();
  const tasks = data?.tasks ?? [];
  return (
    <>
      <WidgetHeader
        id="tickets"
        icon={ListTodo}
        title="Tickets"
        count={data ? data.inProgress + data.open : null}
        note={!data ? (failed ? "couldn't read" : "") : `${data.inProgress} in progress · ${data.open} to do`}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the tickets." : "Loading…"}</Empty>}
          {data && !tasks.length && <Empty>Nothing in progress or to do.</Empty>}
          {tasks.map((t, i) => (
            <div key={t.id} className="contents">
              {(i === 0 || tasks[i - 1].status !== t.status) && <Subhead>{t.status === "in_progress" ? "In progress" : "To do"}</Subhead>}
              <button
                type="button"
                onClick={() => open(`/projects/${encodeURIComponent(t.slug)}/tasks?task=${t.id}`)}
                title={`${t.slug} #${t.id}: ${t.title}${t.assignee ? ` (with ${t.assignee})` : ""}`}
                className={ROW}
              >
                <StatusDot
                  color={t.status === "in_progress" ? "bg-amber-500" : "bg-muted-foreground/30"}
                  pulse={t.status === "in_progress"}
                  size="sm"
                  label={t.status === "in_progress" ? "In progress" : "To do"}
                />
                <span className="min-w-0 truncate text-foreground/90">{t.title}</span>
                <span className="ml-auto shrink-0 text-[10px] opacity-60">{t.assignee ?? t.slug}</span>
              </button>
            </div>
          ))}
          {!!data?.done.length && (
            <>
              <Subhead>Recently done</Subhead>
              {data.done.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => open(`/projects/${encodeURIComponent(t.slug)}/tasks?task=${t.id}`)}
                  title={`${t.slug} #${t.id}: ${t.title}, done ${ago(t.at)}${t.assignee ? ` (by ${t.assignee})` : ""}`}
                  className={cn(ROW, "opacity-75")}
                >
                  <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0 truncate line-through decoration-foreground/25">{t.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] opacity-60">{ago(t.at)}</span>
                </button>
              ))}
            </>
          )}
        </WidgetList>
      )}
    </>
  );
}

type Signins = {
  connected: { key: string; who: string; browser: string; ip: string | null; since: string }[];
  failedToday: number;
  failed: { id: number; at: string; reason: string; username: string | null; ip: string | null }[];
};

/** Sign-ins: who's connected now, and the sign-ins that failed today; a row opens Logins. */
export function SigninsWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<Signins>("/api/widgets/signins", 30_000);
  const open = useOpenPath();
  return (
    <>
      <WidgetHeader
        id="signins"
        icon={KeyRound}
        title="Sign-ins"
        count={data ? data.connected.length : null}
        note={!data ? (failed ? "couldn't read" : "") : data.failedToday ? `${data.failedToday} failed today` : "no failed sign-ins today"}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the sign-ins." : "Loading…"}</Empty>}
          {data && (
            <>
              <Subhead>Connected</Subhead>
              {!data.connected.length && <Empty>Nobody right now.</Empty>}
              {data.connected.map((s) => (
                <button key={s.key} type="button" onClick={() => open("/logins")} title={`${s.who}: ${s.browser}${s.ip ? ` from ${s.ip}` : ""}, since ${ago(s.since)}`} className={ROW}>
                  <StatusDot color="bg-emerald-500" size="sm" label="Connected" />
                  <span className="max-w-[65%] shrink-0 truncate text-foreground/90">{s.who}</span>
                  <span className="ml-auto min-w-0 truncate text-[10px] opacity-60">{s.browser}</span>
                </button>
              ))}
              <Subhead>Failed today{data.failedToday > data.failed.length ? ` (${data.failedToday})` : ""}</Subhead>
              {!data.failed.length && <Empty>None.</Empty>}
              {data.failed.map((f) => (
                <button key={f.id} type="button" onClick={() => open("/logins?failed=1")} title={`${f.reason}${f.username ? ` as ${f.username}` : ""}${f.ip ? ` from ${f.ip}` : ""}, ${ago(f.at)}`} className={ROW}>
                  <StatusDot color="bg-red-500" size="sm" label="Failed" />
                  <span className="min-w-0 truncate">{f.username || f.ip || "unknown"}</span>
                  <span className="min-w-0 truncate text-[10px] opacity-60">{f.reason}</span>
                  <span className="ml-auto shrink-0 text-[10px] opacity-60">{ago(f.at)}</span>
                </button>
              ))}
            </>
          )}
        </WidgetList>
      )}
    </>
  );
}

type Proc = { pid: number; ppid: number; user: string; cpu: number; mem: number; name: string; port: string };
/** The admin's own servers, by port (their process is a "MainThread"): prod and dev, as this box runs them. */
const ADMIN_PORTS: Record<string, string> = { "3002": "admin", "3003": "admin-dev" };

/**
 * Processes: the busiest ones, by CPU or by memory (the switch, remembered), each its figure drawn behind it, the
 * port it listens on; named for what they are where the process name says little (the admin's servers, a project's
 * dev server by its port). From the stats daemon's latest look (/api/processes, every 5 s); a row opens Processes.
 */
export function ProcessesWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ processes: Proc[] }>("/api/processes", 5000);
  const { data: projs } = usePolled<{ projects?: ProjectNavItem[] }>("/api/projects", 30_000);
  const [by, setBy] = useWidgetView<"cpu" | "mem">("processes", "sort", ["cpu", "mem"], "cpu");
  const open = useOpenPath();
  const owner = new Map((projs?.projects ?? []).flatMap((p) => p.ports.map((port) => [String(port), p.slug] as const)));
  const label = (p: Proc) =>
    ADMIN_PORTS[p.port] ?? owner.get(p.port) ?? (p.name === "MainThread" ? "node" : p.name.replace(/ \(v?\d*$/, ""));
  const list = [...(data?.processes ?? [])].sort((a, b) => (by === "cpu" ? b.cpu - a.cpu || b.mem - a.mem : b.mem - a.mem)).slice(0, 30);
  const value = (p: Proc) => (by === "cpu" ? p.cpu : p.mem);
  const top = Math.max(by === "cpu" ? 1 : 64, ...list.map(value));
  const show = (p: Proc, m: "cpu" | "mem") => (m === "cpu" ? `${p.cpu.toFixed(1)}%` : p.mem > 0 ? formatBytes(p.mem * 1024 * 1024) : "—");
  const color = by === "cpu" ? "#0ea5e9" : "#8b5cf6";
  const lead = list[0];
  return (
    <>
      <WidgetHeader
        id="processes"
        icon={Cpu}
        title="Processes"
        count={lead ? show(lead, by) : null}
        note={lead ? `${label(lead)} ${by === "cpu" ? "busiest" : "biggest"}` : failed ? "couldn't read" : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          <div className="flex items-center gap-2 pr-2 pb-1.5 pl-7 text-[11px] text-muted-foreground">
            <span>{data ? `${data.processes.length} busiest` : ""}</span>
            <span className="ml-auto" />
            <ViewSwitch
              label="Sort the processes by"
              value={by}
              onChange={setBy}
              options={[
                { value: "cpu", label: "CPU" },
                { value: "mem", label: "Memory" },
              ]}
            />
          </div>
          {!data && <Empty>{failed ? "Couldn't read the processes." : "Loading…"}</Empty>}
          {list.map((p) => (
            <button
              key={p.pid}
              type="button"
              onClick={() => open("/processes")}
              title={`${p.name} (pid ${p.pid}, ${p.user})${p.port ? ` on :${p.port}` : ""}: ${show(p, "cpu")} CPU, ${show(p, "mem")}`}
              className={cn(ROW, "relative isolate overflow-hidden")}
            >
              {/* (its share of the busiest's, drawn behind it) */}
              <span aria-hidden className="absolute inset-y-0 left-0 -z-10 rounded-md opacity-[0.12] transition-[width] duration-500" style={{ width: `${(value(p) / top) * 100}%`, background: color }} />
              <span className="min-w-0 truncate text-foreground/90">{label(p)}</span>
              <span className="shrink-0 font-mono text-[9px] opacity-50">{p.pid}</span>
              {p.port && <span className="shrink-0 font-mono text-[9px] text-emerald-700 dark:text-emerald-400">:{p.port}</span>}
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{show(p, by)}</span>
              <span className="w-12 shrink-0 text-right font-mono text-[9px] tabular-nums opacity-50">{show(p, by === "cpu" ? "mem" : "cpu")}</span>
            </button>
          ))}
        </WidgetList>
      )}
    </>
  );
}

type DockerRow = { id: string; name: string; image: string; state: string; status: string; ports: string; cpu: number | null; memBytes: number | null };

/**
 * Docker: every container, the running first (the biggest first), with its image, the port it publishes, its memory
 * and CPU (its memory drawn behind it), then how many images and how big; a row opens Docker.
 */
export function DockerWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ available: boolean; containers: DockerRow[]; images: { count: number; bytes: number } }>("/api/widgets/docker", 15_000);
  const open = useOpenPath();
  const list = data?.containers ?? [];
  const running = list.filter((c) => c.state === "running");
  const mem = running.reduce((n, c) => n + (c.memBytes ?? 0), 0);
  const top = Math.max(1, ...list.map((c) => c.memBytes ?? 0));
  // (the host port a container publishes, the first if several)
  const port = (p: string) => /:(\d+)->/.exec(p)?.[1] ?? null;
  const state = (c: DockerRow): { color: string; label: string; pulse?: boolean } =>
    c.state === "running"
      ? c.status.includes("(unhealthy)")
        ? { color: "bg-red-500", label: "Unhealthy", pulse: true }
        : { color: "bg-emerald-500", label: "Running" }
      : c.state === "restarting"
        ? { color: "bg-amber-500", label: "Restarting", pulse: true }
        : { color: "bg-muted-foreground/30", label: c.status };
  return (
    <>
      <WidgetHeader
        id="docker"
        icon={Container}
        title="Docker"
        count={data ? `${running.length}/${list.length}` : null}
        note={!data ? (failed ? "couldn't read" : "") : data.available ? `${running.length} running · ${formatBytes(mem)}` : "not available"}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read Docker." : "Loading…"}</Empty>}
          {data && !data.available && <Empty>Docker isn&apos;t answering.</Empty>}
          {data?.available && !list.length && <Empty>No containers.</Empty>}
          {list.map((c) => {
            const s = state(c);
            const p = port(c.ports);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => open("/docker")}
                title={`${c.name} (${c.image}): ${c.status}${c.ports ? ` · ${c.ports}` : ""}${c.memBytes != null ? ` · ${formatBytes(c.memBytes)}, ${c.cpu?.toFixed(1)}% CPU` : ""}`}
                className={cn(ROW, "relative isolate overflow-hidden", c.state !== "running" && "opacity-60")}
              >
                {c.memBytes ? (
                  <span aria-hidden className="absolute inset-y-0 left-0 -z-10 rounded-md bg-indigo-500 opacity-[0.1]" style={{ width: `${(c.memBytes / top) * 100}%` }} />
                ) : null}
                <StatusDot color={s.color} pulse={s.pulse} size="sm" label={s.label} />
                <span className="min-w-0 truncate text-foreground/90">{c.name}</span>
                <span className="min-w-0 truncate text-[9px] opacity-50">{c.image.split("/").pop()}</span>
                {p && <span className="shrink-0 font-mono text-[9px] text-emerald-700 dark:text-emerald-400">:{p}</span>}
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{c.memBytes != null ? formatBytes(c.memBytes) : "—"}</span>
                <span className="w-10 shrink-0 text-right font-mono text-[9px] tabular-nums opacity-55">{c.cpu != null ? `${c.cpu.toFixed(1)}%` : ""}</span>
              </button>
            );
          })}
          {data?.available && <Empty>{`${data.images.count} image${data.images.count === 1 ? "" : "s"} · ${formatBytes(data.images.bytes)}`}</Empty>}
        </WidgetList>
      )}
    </>
  );
}
