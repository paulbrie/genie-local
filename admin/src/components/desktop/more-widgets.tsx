"use client";

import { ArrowDown, ArrowUp, Bot, Container, GitBranch, Gauge, HeartPulse, KeyRound, ListTodo, MemoryStick, Server, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useSubject } from "subjecto/react";

import { ago, Empty, ROW, Subhead, useOpenPath, usePolled, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";
import type { SystemStats } from "@/lib/stats";
import { cn } from "@/lib/utils";
import type { HealthItem, HealthState, RepoState } from "@/lib/widgets-core";
import { projectMemory } from "@/store/project-memory";
import { liveTerminals, openTerminal } from "@/store/terminals";

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

/** Tickets: what's in progress (and who has it), then what's to do, across the projects; a row opens the ticket. */
export function TicketsWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<{ inProgress: number; open: number; tasks: Ticket[] }>("/api/widgets/tickets", 30_000);
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

/** Distinct, steady colours for the memory bar's segments (a name's hue; the next free one when two would match). */
const PALETTE = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#f43f5e", "#14b8a6", "#6366f1", "#d946ef", "#84cc16", "#f97316"];

function colorsFor(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  for (const n of names) {
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let i = h % PALETTE.length;
    for (let k = 0; k < PALETTE.length && used.has(i); k++) i = (i + 1) % PALETTE.length;
    used.add(i);
    out.set(n, PALETTE[i]);
  }
  return out;
}

/** A segment of the bar, or a row under it: its own part, and (projects) its Claude agents, drawn striped after it. */
type Share = { key: string; label: string; bytes: number; agents: number; color: string; open: () => void; title: string };

/**
 * Memory: the server's RAM as one bar, in the way of macOS's storage bar: each project a segment in its colour, its
 * Claude agents striped after it, then the system and everything else, then what's free; under it the four totals,
 * and a row a project (its share drawn behind it). Hovering a row lights its segments up, and the other way round.
 * By terminal instead with the switch. The figures are the top bar's (projectMemory, liveTerminals), live.
 */
export function MemoryWidget({ folded }: { folded: boolean }) {
  const [status] = useSubject(projectMemory);
  const [terms] = useSubject(liveTerminals);
  const [view, setView] = useState<"projects" | "terminals">("projects");
  const [hot, setHot] = useState<string | null>(null);
  const openPath = useOpenPath();
  const total = status?.server.totalBytes ?? 0;
  const free = status?.server.availableBytes ?? 0;
  const used = Math.max(0, total - free);

  const projs = (status?.projects ?? []).filter((p) => p.bytes > 0 || p.agentBytes > 0).sort((a, b) => b.bytes + b.agentBytes - (a.bytes + a.agentBytes));
  const projBytes = projs.reduce((n, p) => n + p.bytes, 0);
  const agentBytes = projs.reduce((n, p) => n + p.agentBytes, 0);
  const projColors = colorsFor(projs.map((p) => p.slug));
  const termList = terms.filter((t) => t.memBytes).sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0));
  const termColors = colorsFor(termList.map((t) => t.name));
  const pct = (b: number) => (total ? (b / total) * 100 : 0);

  const shares: Share[] =
    view === "projects"
      ? projs.map((p) => ({
          key: p.slug,
          label: p.slug,
          bytes: p.bytes,
          agents: p.agentBytes,
          color: projColors.get(p.slug)!,
          open: () => openPath(`/projects/${encodeURIComponent(p.slug)}/memory`),
          title: `${p.slug}: ${formatBytes(p.bytes)}${p.agentBytes ? ` + ${formatBytes(p.agentBytes)} in Claude agents` : ""} · ${pct(p.bytes + p.agentBytes).toFixed(1)}% of RAM`,
        }))
      : termList.map((t) => ({
          key: t.name,
          label: t.name,
          bytes: t.memBytes ?? 0,
          agents: 0,
          color: termColors.get(t.name)!,
          open: () => openTerminal(t.name),
          title: `${t.name}: ${formatBytes(t.memBytes ?? 0)} · ${pct(t.memBytes ?? 0).toFixed(1)}% of RAM`,
        }));
  const shown = shares.reduce((n, s) => n + s.bytes + s.agents, 0);
  // (terminals: their memory is their projects' too, so the rest is everything else that's in use)
  const rest = Math.max(0, used - shown);
  const top = Math.max(1, ...shares.map((s) => s.bytes + s.agents));
  const stripes = (c: string) => `repeating-linear-gradient(135deg, ${c} 0 2px, color-mix(in oklab, ${c} 35%, transparent) 2px 4px)`;
  // (a legend's swatch for many: their colours round a little wheel)
  const wheel = (cs: string[]) => (cs.length > 1 ? `conic-gradient(${cs.slice(0, 6).join(", ")}, ${cs[0]})` : (cs[0] ?? "#a1a1aa"));
  const dim = (key: string) => hot !== null && hot !== key;

  return (
    <>
      <WidgetHeader
        id="memory"
        icon={MemoryStick}
        title="Memory"
        count={status ? `${Math.round(pct(used))}%` : null}
        note={status ? `${formatBytes(free)} free` : ""}
        folded={folded}
      />
      {!folded && (
        <WidgetList>
          {!status && <Empty>Loading…</Empty>}
          {status && (
            <div className="flex flex-col gap-2 pr-2 pb-1.5 pl-7">
              {/* (the headline: how much is in use, of how much; the view's switch at its right) */}
              <div className="flex items-end gap-2">
                <span className="text-xl leading-none font-semibold tracking-tight tabular-nums">{formatBytes(used)}</span>
                <span className="pb-px text-[11px] leading-none text-muted-foreground">used of {formatBytes(total)}</span>
                <div role="group" aria-label="Show memory by" className="ml-auto flex shrink-0 rounded-md bg-foreground/[0.06] p-0.5 text-[10px]">
                {(["projects", "terminals"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={cn("rounded px-2 py-0.5 capitalize text-muted-foreground transition-colors", view === v && "bg-background text-foreground shadow-sm")}
                  >
                    {v}
                  </button>
                ))}
                </div>
              </div>
              {/* the bar: every share, then the rest in use, then (the track) what's free */}
              <TooltipProvider delay={80} closeDelay={40}>
                <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full bg-foreground/[0.07] shadow-inner" onPointerLeave={() => setHot(null)}>
                  {shares.map((s) => (
                    <Tooltip key={s.key}>
                      <TooltipTrigger
                        render={<div />}
                        onPointerEnter={() => setHot(s.key)}
                        className="flex h-full shrink-0 gap-[1px] transition-opacity duration-150"
                        style={{ width: `${pct(s.bytes + s.agents)}%`, minWidth: 3, opacity: dim(s.key) ? 0.3 : 1 }}
                      >
                        <div className="h-full" style={{ flex: s.bytes || 0.0001, background: s.color }} />
                        {s.agents > 0 && <div className="h-full" style={{ flex: s.agents, background: stripes(s.color) }} />}
                      </TooltipTrigger>
                      <TooltipContent side="top">{s.title}</TooltipContent>
                    </Tooltip>
                  ))}
                  {rest > 0 && (
                    <Tooltip>
                      <TooltipTrigger
                        render={<div />}
                        onPointerEnter={() => setHot("rest")}
                        className="h-full shrink-0 bg-foreground/30 transition-opacity duration-150"
                        style={{ width: `${pct(rest)}%`, opacity: dim("rest") ? 0.3 : 1 }}
                      />
                      <TooltipContent side="top">
                        {view === "projects" ? "System and everything else" : "Everything else in use"}: {formatBytes(rest)}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TooltipProvider>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {(view === "projects"
                  ? [
                      { label: "Projects", bytes: projBytes, swatch: <span className="size-2 rounded-full" style={{ background: wheel(shares.map((x) => x.color)) }} /> },
                      { label: "Agents", bytes: agentBytes, swatch: <span className="size-2 rounded-full" style={{ background: stripes("#a1a1aa") }} /> },
                      { label: "System", bytes: rest, swatch: <span className="size-2 rounded-full bg-foreground/30" /> },
                      { label: "Free", bytes: free, swatch: <span className="size-2 rounded-full bg-foreground/[0.07] ring-1 ring-foreground/15" /> },
                    ]
                  : [
                      { label: "Terminals", bytes: shown, swatch: <span className="size-2 rounded-full" style={{ background: wheel(shares.map((x) => x.color)) }} /> },
                      { label: "Other", bytes: rest, swatch: <span className="size-2 rounded-full bg-foreground/30" /> },
                      { label: "Free", bytes: free, swatch: <span className="size-2 rounded-full bg-foreground/[0.07] ring-1 ring-foreground/15" /> },
                    ]
                ).map((x) => (
                  <span key={x.label} className="flex items-center gap-1.5">
                    {x.swatch}
                    {x.label}
                    <span className="ml-auto font-mono tabular-nums text-foreground/80">{formatBytes(x.bytes)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {status && !shares.length && <Empty>{view === "projects" ? "Nothing running in a project." : "No terminal's memory known yet."}</Empty>}
          {shares.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={s.open}
              onPointerEnter={() => setHot(s.key)}
              onPointerLeave={() => setHot(null)}
              title={s.title}
              className={cn(ROW, "relative isolate overflow-hidden", hot === s.key && "text-foreground")}
            >
              {/* (its share, drawn behind it in its colour) */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 -z-10 rounded-md transition-[width,opacity] duration-300"
                style={{ width: `${((s.bytes + s.agents) / top) * 100}%`, background: s.color, opacity: hot === s.key ? 0.22 : 0.1 }}
              />
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">{s.bytes ? formatBytes(s.bytes) : "—"}</span>
              {s.agents > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums opacity-60" title="Claude sessions working in it">
                  <Bot className="size-2.5" />
                  {formatBytes(s.agents)}
                </span>
              )}
            </button>
          ))}
        </WidgetList>
      )}
    </>
  );
}
