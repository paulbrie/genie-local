import { notFound } from "next/navigation";

import { AppCard } from "@/components/project-app-card";
import { getProject } from "@/lib/project-page";
import { readScripts } from "@/lib/signals";

export const dynamic = "force-dynamic";

/** /projects/<slug>/scripts: one card per app, with its scripts to run. */
export default async function ProjectScriptsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const { project, apps } = detail;
  if (apps.length === 0) {
    return <p className="text-sm text-muted-foreground">No apps discovered in this project yet.</p>;
  }
  const appScripts = await Promise.all(apps.map(({ app }) => readScripts(app.path)));
  return (
    <div className="space-y-4">
      {apps.map(({ app, snapshots }, i) => (
        <AppCard
          key={app.id}
          projectSlug={project.slug}
          singleApp={apps.length === 1}
          app={app}
          snapshots={snapshots}
          scripts={appScripts[i]}
        />
      ))}
    </div>
  );
}
