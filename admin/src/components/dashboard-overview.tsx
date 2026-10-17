import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import type { DashboardMetrics } from "@/lib/dashboard-metrics";
import { formatBytes, formatRelativeTime } from "@/lib/format";

const STATUS_TEXT: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** A headline number for one area, linking to its page. */
function StatTile({
  href,
  label,
  value,
  unit,
  children,
}: {
  href: string;
  label: string;
  value: number | string | null;
  unit?: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
    >
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight">{value ?? "—"}</span>
        {unit && value != null && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{value == null ? "Unavailable" : children}</div>
    </Link>
  );
}

/** A ratio against its limit: one hue, track a lighter step of it; "high" past 85 %. */
function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const high = percent >= 85;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {high && <span className="mr-1.5 font-medium text-amber-700 dark:text-amber-400">high</span>}
          {Math.round(percent)}% · {detail}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={`h-2 overflow-hidden rounded-full ${high ? "bg-amber-500/20" : "bg-primary/15"}`}
      >
        <div
          className={`h-full rounded-full ${high ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center gap-2 py-1.5 text-sm">{children}</li>;
}

/** The Dashboard: every area's headline numbers, what needs you, and recent activity. */
export function DashboardOverview({ m }: { m: DashboardMetrics }) {
  const attention = [
    ...(m.terminals?.needsInput ?? []).map((name) => ({
      key: `t-${name}`,
      href: "/terminals",
      text: `${name} is waiting on you`,
    })),
    ...(m.services?.failed ?? []).map((unit) => ({
      key: `s-${unit}`,
      href: "/services",
      text: `${unit} failed`,
    })),
    ...(m.agents?.failedRecently
      ? [{ key: "agents", href: "/agents", text: `${m.agents.failedRecently} agent run${m.agents.failedRecently === 1 ? "" : "s"} failed this week` }]
      : []),
    ...(m.projects.dirtyRepos.length
      ? [{ key: "dirty", href: "/projects", text: `${m.projects.dirtyRepos.length} repo${m.projects.dirtyRepos.length === 1 ? " has" : "s have"} uncommitted changes`, title: m.projects.dirtyRepos.join(", ") }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/projects" label="Projects" value={m.projects.active} unit="active">
          {m.projects.running} running
          {m.projects.appsMemBytes ? ` · ${formatBytes(m.projects.appsMemBytes)} in use` : ""}
        </StatTile>
        <StatTile href="/projects" label="Tickets" value={m.tasks.open + m.tasks.inProgress} unit="to do">
          {m.tasks.open} open · {m.tasks.inProgress} in progress · {m.tasks.doneThisWeek} done this week
        </StatTile>
        <StatTile
          href="/terminals"
          label="Claude terminals"
          value={m.terminals ? m.terminals.claudeWorking : null}
          unit="working"
        >
          {m.terminals && (
            <>
              {m.terminals.claudeIdle} idle
              {m.terminals.needsInput.length > 0 && (
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  {" "}
                  · {m.terminals.needsInput.length} waiting on you
                </span>
              )}{" "}
              · {fmtTokens(m.terminals.tokens)} tokens
            </>
          )}
        </StatTile>
        <StatTile href="/agents" label="Agent runs" value={m.agents ? m.agents.running : null} unit="running">
          {m.agents && `${m.agents.total} runs kept · ${m.agents.failedRecently} failed this week`}
        </StatTile>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">Server</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {m.server ? (
              <>
                <Meter label="CPU" percent={m.server.cpuPercent} detail={`${m.server.cpuCores} cores`} />
                <Meter
                  label="Memory"
                  percent={m.server.memPercent}
                  detail={`${formatBytes(m.server.memUsedBytes)} of ${formatBytes(m.server.memTotalBytes)}`}
                />
                <Meter
                  label="Disk"
                  percent={m.server.diskPercent}
                  detail={`${formatBytes(m.server.diskUsedBytes)} of ${formatBytes(m.server.diskTotalBytes)}`}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Server stats unavailable.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Infrastructure</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              <Row>
                <Link href="/docker" className="hover:underline">Docker</Link>
                <span className="ml-auto text-muted-foreground">
                  {m.docker ? `${m.docker.running} running · ${formatBytes(m.docker.memBytes)}` : "unavailable"}
                </span>
              </Row>
              <Row>
                <Link href="/services" className="hover:underline">Services</Link>
                <span className="ml-auto text-muted-foreground">
                  {m.services ? `${m.services.active} of ${m.services.total} active` : "unavailable"}
                  {m.services && m.services.failed.length > 0 && (
                    <span className="font-medium text-red-700 dark:text-red-400"> · {m.services.failed.length} failed</span>
                  )}
                </span>
              </Row>
              <Row>
                <Link href="/chrome" className="hover:underline">Chrome</Link>
                <span className="ml-auto text-muted-foreground">
                  {m.chrome ? `${m.chrome.instances} instance${m.chrome.instances === 1 ? "" : "s"}` : "unavailable"}
                </span>
              </Row>
              <Row>
                <Link href="/terminals" className="hover:underline">Terminals</Link>
                <span className="ml-auto text-muted-foreground">
                  {m.terminals ? `${m.terminals.total} open` : "unavailable"}
                </span>
              </Row>
              <Row>
                <Link href="/projects" className="hover:underline">Apps running</Link>
                <span className="ml-auto text-muted-foreground">
                  {m.projects.appsRunning ?? "—"}
                </span>
              </Row>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
            {attention.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <StatusDot color="bg-emerald-500" label="All clear" /> All clear
              </p>
            ) : (
              <ul className="divide-y">
                {attention.map((a) => (
                  <Row key={a.key}>
                    <StatusDot color="bg-amber-500" label="Needs attention" />
                    <Link href={a.href} title={"title" in a ? a.title : undefined} className="min-w-0 truncate hover:underline">
                      {a.text}
                    </Link>
                  </Row>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Recent ticket activity</CardTitle>
          </CardHeader>
          <CardContent>
            {m.tasks.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets yet.</p>
            ) : (
              <ul className="divide-y">
                {m.tasks.recent.map((t) => (
                  <Row key={t.id}>
                    <span className="w-24 shrink-0 text-xs text-muted-foreground">{STATUS_TEXT[t.status] ?? t.status}</span>
                    <Link
                      href={`/projects/${encodeURIComponent(t.project)}/tasks`}
                      className="min-w-0 flex-1 truncate hover:underline"
                    >
                      <span className="font-mono text-xs text-muted-foreground">#{t.id}</span> {t.title}
                    </Link>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {t.project}
                      {t.assignee ? ` · ${t.assignee}` : ""}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {formatRelativeTime(t.updatedAt)}
                    </span>
                  </Row>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Latest commits</CardTitle>
          </CardHeader>
          <CardContent>
            {m.projects.recentCommits.length === 0 ? (
              <p className="text-sm text-muted-foreground">No commits recorded.</p>
            ) : (
              <ul className="divide-y">
                {m.projects.recentCommits.map((c) => (
                  <Row key={`${c.project}/${c.app}`}>
                    <Link
                      href={
                        c.lastCommitHash
                          ? `/projects/${encodeURIComponent(c.project)}/git/${c.lastCommitHash}${c.app ? `?app=${encodeURIComponent(c.app)}` : ""}`
                          : `/projects/${encodeURIComponent(c.project)}/git`
                      }
                      className="min-w-0 flex-1 truncate hover:underline"
                    >
                      {c.project}
                      {c.app ? <span className="text-muted-foreground">/{c.app}</span> : null}
                    </Link>
                    {c.lastCommitHash && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.lastCommitHash.slice(0, 7)}</span>
                    )}
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {formatRelativeTime(c.lastCommitAt)}
                    </span>
                  </Row>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
