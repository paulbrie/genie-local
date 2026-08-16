import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { appServerMemBytes, isAppServerRunning } from "@/lib/run-slug";
import type { AppSignals, ProjectSignals } from "@/lib/types";

export function appLabel(app: AppSignals): string {
  return app.name ?? (app.slug === "" ? "(root)" : app.slug);
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className="relative flex size-2 shrink-0 items-center justify-center"
      title={running ? "running" : "stopped"}
    >
      {running && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
      )}
      <span
        className={`relative inline-flex size-2 rounded-full ${
          running ? "bg-emerald-500" : "bg-muted-foreground/30"
        }`}
      />
    </span>
  );
}

function AppRow({ app, running }: { app: AppSignals; running: boolean }) {
  const { git, fs } = app;
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-lg border py-1.5 pr-2.5 pl-2.5 text-sm transition-colors ${
        running
          ? "border-l-[3px] border-emerald-500/50 border-l-emerald-500 bg-emerald-500/[0.06] pl-2"
          : "border-border/60 bg-muted/30 hover:bg-muted/60"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot running={running} />
        <span
          className="max-w-[55%] shrink-0 truncate font-medium"
          title={appLabel(app)}
        >
          {appLabel(app)}
        </span>
        {app.isGit ? (
          <Badge
            variant="secondary"
            className="max-w-[7.5rem] min-w-0 shrink truncate font-mono text-[10px] font-normal"
            title={git.branch ?? "git"}
          >
            {git.branch ?? "git"}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            no git
          </Badge>
        )}
        {git.dirty === true && (
          <Badge variant="destructive" className="shrink-0 text-[10px]">
            {git.dirtyCount ? `${git.dirtyCount} dirty` : "dirty"}
          </Badge>
        )}
        {app.errors.length > 0 && (
          <Badge variant="destructive" className="shrink-0 text-[10px]">
            error
          </Badge>
        )}
      </div>
      <span className="shrink-0 text-xs tabular-nums">
        {running ? (
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            live
          </span>
        ) : (
          <span className="text-muted-foreground">
            {git.lastCommitAt
              ? formatRelativeTime(git.lastCommitAt)
              : formatBytes(fs.sizeBytes)}
          </span>
        )}
      </span>
    </div>
  );
}

export function ProjectCard({
  project,
  running,
  memory,
}: {
  project: ProjectSignals;
  running: Set<string>;
  memory: Record<string, number>;
}) {
  const appCount = project.apps.length;
  const dirtyCount = project.apps.filter((a) => a.git.dirty === true).length;
  const runningCount = project.apps.filter((a) =>
    isAppServerRunning(running, project.slug, a.slug),
  ).length;
  const memBytes = project.apps.reduce(
    (sum, a) => sum + appServerMemBytes(memory, project.slug, a.slug),
    0,
  );

  // Most recent commit across the project's apps, for the description line.
  const lastActivity = project.apps
    .map((a) => a.git.lastCommitAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  return (
    <Link
      href={`/projects/${project.slug}`}
      className="group/link block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        className={`relative h-full overflow-hidden transition-all group-hover/link:-translate-y-0.5 group-hover/link:shadow-md ${
          runningCount > 0
            ? "ring-emerald-500/40 group-hover/link:ring-emerald-500/60"
            : "group-hover/link:ring-foreground/25"
        }`}
      >
        {/* Left accent rail when the project has a live app */}
        {runningCount > 0 && (
          <span className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-emerald-500" />
        )}
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="truncate text-[15px]" title={project.slug}>
              {project.slug}
            </CardTitle>
            <Badge variant="outline" className="shrink-0 tabular-nums">
              {appCount} {appCount === 1 ? "app" : "apps"}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            {lastActivity
              ? `Last commit ${formatRelativeTime(lastActivity)}`
              : "No commits yet"}
          </CardDescription>

          {(runningCount > 0 || dirtyCount > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {runningCount > 0 && (
                <Badge
                  className="gap-1 border-transparent bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400"
                  title={
                    memBytes > 0
                      ? "Resident memory of this project's running apps"
                      : undefined
                  }
                >
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                  </span>
                  {runningCount} running
                  {memBytes > 0 && (
                    <span className="font-mono tabular-nums opacity-80">
                      · {formatBytes(memBytes)}
                    </span>
                  )}
                </Badge>
              )}
              {dirtyCount > 0 && (
                <Badge variant="destructive">{dirtyCount} dirty</Badge>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-1.5">
          {appCount === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 py-4 text-center text-sm text-muted-foreground">
              No apps yet
            </p>
          ) : (
            project.apps.map((app) => (
              <AppRow
                key={app.slug || "(root)"}
                app={app}
                running={isAppServerRunning(running, project.slug, app.slug)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
