import Link from "next/link";
import { notFound } from "next/navigation";

import { AppPortForm } from "@/components/app-port-form";
import { NotesPanel } from "@/components/notes-panel";
import { appLabel } from "@/components/project-card";
import { RescanProjectButton } from "@/components/rescan-project-button";
import { ScriptRow } from "@/components/script-row";
import { TaskList } from "@/components/task-list";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AppRow, SnapshotRow } from "@/lib/scan";
import { getNotes, getTasks } from "@/lib/data";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { mountPath } from "@/lib/nginx";
import { statusFor } from "@/lib/runner";
import { getProjectDetail } from "@/lib/scan";
import { readScripts } from "@/lib/signals";
import type { AppSignals } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProjectDetail(slug);
  if (!detail) notFound();

  const { project, apps } = detail;
  const [notes, tasks] = await Promise.all([
    getNotes(project.id),
    getTasks(project.id),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← All projects
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {project.slug}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">
            {project.path} · {apps.length} {apps.length === 1 ? "app" : "apps"}
          </p>
        </div>
        <RescanProjectButton slug={project.slug} />
      </div>

      {/* One card per app (sub-project) */}
      <section className="space-y-4">
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No apps discovered in this project yet.
          </p>
        ) : (
          apps.map(({ app, snapshots }) => (
            <AppCard
              key={app.id}
              projectSlug={project.slug}
              singleApp={apps.length === 1}
              app={app}
              snapshots={snapshots}
            />
          ))
        )}
      </section>

      {/* Project-level notes & tasks */}
      <Tabs defaultValue="notes">
        <TabsList>
          <TabsTrigger value="notes">Notes ({notes.length})</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({tasks.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="notes" className="pt-4">
          <NotesPanel slug={project.slug} notes={notes} />
        </TabsContent>
        <TabsContent value="tasks" className="pt-4">
          <TaskList slug={project.slug} tasks={tasks} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

async function AppCard({
  projectSlug,
  singleApp,
  app,
  snapshots,
}: {
  projectSlug: string;
  singleApp: boolean;
  app: AppRow;
  snapshots: SnapshotRow[];
}) {
  const latest = snapshots[0];
  const raw = latest?.raw as AppSignals | null | undefined;
  const label = raw
    ? appLabel(raw)
    : (app.name ?? (app.slug === "" ? "(root)" : app.slug));
  const scripts = await readScripts(app.path);
  const scriptEntries = Object.entries(scripts);
  const scriptStatuses = await Promise.all(
    scriptEntries.map(([name]) => statusFor(projectSlug, app.slug, name)),
  );
  const anyRunning = scriptStatuses.some((s) => s.running);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              role="img"
              aria-label={anyRunning ? "Running" : "Stopped"}
              className="relative flex size-2.5 shrink-0 items-center justify-center"
              title={anyRunning ? "running" : "stopped"}
            >
              {anyRunning && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
              )}
              <span
                className={`relative inline-flex size-2.5 rounded-full ${
                  anyRunning ? "bg-emerald-500" : "bg-muted-foreground/30"
                }`}
              />
            </span>
            <CardTitle className="truncate text-base">{label}</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            {app.isGit ? (
              <Badge variant="secondary">{latest?.gitBranch ?? "git"}</Badge>
            ) : (
              <Badge variant="outline">no git</Badge>
            )}
            {latest?.gitDirty === true && (
              <Badge variant="destructive">dirty</Badge>
            )}
            {latest?.gitDirty === false && (
              <Badge variant="secondary">clean</Badge>
            )}
          </div>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{app.path}</p>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Last commit"
            value={formatRelativeTime(latest?.lastCommitAt ?? null)}
          />
          <Stat label="Size" value={formatBytes(latest?.sizeBytes ?? null)} />
          <Stat
            label="Ahead / behind"
            value={`${latest?.ahead ?? 0} / ${latest?.behind ?? 0}`}
          />
          <Stat
            label="Commit"
            value={
              latest?.lastCommitHash
                ? latest.lastCommitHash.slice(0, 8)
                : "—"
            }
          />
        </div>

        {raw && (
          <div className="flex flex-wrap gap-1.5">
            {raw.fs.hasPackageJson && (
              <Badge variant="outline">package.json</Badge>
            )}
            {raw.fs.hasReadme && <Badge variant="outline">README</Badge>}
            {raw.fs.hasEnv && <Badge variant="outline">.env</Badge>}
            {raw.fs.hasDockerfile && <Badge variant="outline">Dockerfile</Badge>}
            {typeof raw.pkg.dependencyCount === "number" && (
              <Badge variant="outline">{raw.pkg.dependencyCount} deps</Badge>
            )}
            {raw.errors.length > 0 && (
              <Badge variant="destructive">error</Badge>
            )}
          </div>
        )}

        {scriptEntries.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              Scripts ({scriptEntries.length})
            </div>
            <div className="divide-y rounded-md border">
              {scriptEntries.map(([name, cmd], i) => (
                <ScriptRow
                  key={name}
                  projectSlug={projectSlug}
                  appId={app.id}
                  script={name}
                  command={cmd}
                  initial={scriptStatuses[i]}
                />
              ))}
            </div>
          </div>
        )}

        {snapshots.length > 1 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              History ({snapshots.length})
            </summary>
            <Table className="mt-2">
              <TableHeader>
                <TableRow>
                  <TableHead>Captured</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Dirty</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{formatDateTime(s.capturedAt)}</TableCell>
                    <TableCell>{s.gitBranch ?? "—"}</TableCell>
                    <TableCell>
                      {s.gitDirty === true
                        ? "yes"
                        : s.gitDirty === false
                          ? "no"
                          : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatBytes(s.sizeBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <AppPortForm
            projectSlug={projectSlug}
            appId={app.id}
            port={app.port}
          />
          {/* Raw anchor: not basePath-prefixed, so it targets the live app
              (Nginx /projects/<project>/<app>/), not the admin UI. */}
          {app.port ? (
            <a
              href={mountPath(projectSlug, app.slug, singleApp)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:underline"
            >
              live ↗ (:{app.port})
            </a>
          ) : (
            <Badge
              variant="destructive"
              aria-label="No port configured — set a port to reach the live app"
              title="Set a port to reach the live app"
            >
              no port
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}
