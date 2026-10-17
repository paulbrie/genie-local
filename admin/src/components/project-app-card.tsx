import { AppPortForm } from "@/components/app-port-form";
import { appLabel } from "@/components/project-card";
import { ScriptList } from "@/components/script-row";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AppRow, SnapshotRow } from "@/lib/scan";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { mountPath } from "@/lib/nginx";
import { listeningPortPids, statusForWithPort } from "@/lib/runner";
import type { AppSignals } from "@/lib/types";

/** One app (sub-project) of a project: its git state, scripts and port. */
export async function AppCard({
  projectSlug,
  singleApp,
  app,
  snapshots,
  scripts,
}: {
  projectSlug: string;
  singleApp: boolean;
  app: AppRow;
  snapshots: SnapshotRow[];
  scripts: Record<string, string>;
}) {
  const latest = snapshots[0];
  const raw = latest?.raw as AppSignals | null | undefined;
  const label = raw
    ? appLabel(raw)
    : (app.name ?? (app.slug === "" ? "(root)" : app.slug));
  const scriptEntries = Object.entries(scripts);
  // One `ss` snapshot shared across every script's port fallback (see
  // statusForWithPort) so the dots match the dashboard even on the first paint.
  const portPids = await listeningPortPids();
  const scriptStatuses = await Promise.all(
    scriptEntries.map(([name]) =>
      statusForWithPort(projectSlug, app.slug, name, app.port, portPids),
    ),
  );
  const anyRunning = scriptStatuses.some((s) => s.running);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot
              size="lg"
              color={anyRunning ? "bg-emerald-500" : "bg-muted-foreground/30"}
              pulse={anyRunning}
              label={anyRunning ? "Running" : "Stopped"}
            />
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
            <ScriptList
              projectSlug={projectSlug}
              appSlug={app.slug}
              appId={app.id}
              scripts={scriptEntries.map(([name, command]) => ({
                name,
                command,
              }))}
              initial={scriptStatuses}
            />
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
