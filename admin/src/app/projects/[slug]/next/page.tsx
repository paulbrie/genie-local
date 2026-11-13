import { notFound } from "next/navigation";

import { DeleteNextDirButton } from "@/components/delete-next-dir-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { nextDependency, nextDirInfo } from "@/lib/next-dir";
import { getProject } from "@/lib/project-page";
import { listeningPortPids, statusFor } from "@/lib/runner";
import { readScripts } from "@/lib/signals";

export const dynamic = "force-dynamic";

/**
 * /projects/<slug>/next: each app that depends on `next`, its `.next` (size, biggest entries) and a button deleting
 * it. The app's scripts running from here are stopped first and started again after (deleteNextDirAction); a server
 * on its port started elsewhere can't be, so it's named.
 */
export default async function ProjectNextPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const { project, apps } = detail;
  const versions = await Promise.all(apps.map(({ app }) => nextDependency(app.path)));
  const nextApps = apps.flatMap(({ app }, i) => (versions[i] === null ? [] : [{ app, version: versions[i] }]));
  if (nextApps.length === 0) {
    return <p className="text-sm text-muted-foreground">No app in this project uses Next.js.</p>;
  }
  const portPids = await listeningPortPids();
  const cards = await Promise.all(
    nextApps.map(async ({ app, version }) => {
      const [dir, scripts] = await Promise.all([nextDirInfo(app.path), readScripts(app.path)]);
      const names = Object.keys(scripts);
      const statuses = await Promise.all(names.map((s) => statusFor(project.slug, app.slug, s)));
      const running = names.filter((_, i) => statuses[i].running);
      const outside = running.length === 0 && app.port != null && portPids.has(app.port) ? app.port : null;
      return { app, version, dir, running, outside };
    }),
  );

  return (
    <div className="space-y-4">
      {cards.map(({ app, version, dir, running, outside }) => {
        const label = app.name ?? (app.slug === "" ? project.slug : app.slug);
        return (
          <Card key={app.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <CardTitle className="truncate text-base">{label}</CardTitle>
                  <Badge variant="outline">next {version}</Badge>
                </div>
                <DeleteNextDirButton
                  slug={project.slug}
                  appId={app.id}
                  label={label}
                  size={formatBytes(dir.bytes)}
                  running={running}
                  disabled={!dir.exists}
                />
              </div>
              <p className="font-mono text-xs text-muted-foreground">{dir.path}</p>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {dir.exists ? (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-medium">{formatBytes(dir.bytes)}</span>
                  {dir.top.map((e) => (
                    <span key={e.name} className="text-muted-foreground">
                      <span className="font-mono">{e.name}</span> {formatBytes(e.bytes)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No .next folder: it&apos;s built on the next dev or build.</p>
              )}
              {dir.exists && running.length > 0 && (
                <p className="text-muted-foreground">
                  Running: <span className="font-mono">{running.join(", ")}</span>. Stopped while .next is deleted,
                  then started again.
                </p>
              )}
              {dir.exists && outside != null && (
                <p className="text-amber-700 dark:text-amber-300">
                  A server not started from here is on :{outside}. Restart it after deleting .next.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
