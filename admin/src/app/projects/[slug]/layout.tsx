import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteProjectButton } from "@/components/delete-project-button";
import { ProjectFrame } from "@/components/project-frame";
import { ProjectTabNav } from "@/components/project-tab-nav";
import { RescanProjectButton } from "@/components/rescan-project-button";
import { RestoreProjectButton } from "@/components/restore-project-button";
import { getNotes, getTasks } from "@/lib/data";
import { getProject } from "@/lib/project-page";
import { readScripts } from "@/lib/signals";

/**
 * A project: its header and the tab bar. Each tab is its own page
 * (/projects/<slug>/scripts, /tasks, /notes, /git, /git/<hash>).
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const { project, apps } = detail;

  const [notes, tasks, appScripts] = await Promise.all([
    getNotes(project.id),
    getTasks(project.id),
    Promise.all(apps.map(({ app }) => readScripts(app.path))),
  ]);
  const scriptCount = appScripts.reduce((n, s) => n + Object.keys(s).length, 0);
  const tabs = [
    { id: "scripts", label: `Scripts (${scriptCount})` },
    { id: "tasks", label: `Tasks (${tasks.length})` },
    { id: "notes", label: `Notes (${notes.length})` },
    { id: "memory", label: "Memory" },
    ...(apps.some(({ app }) => app.isGit) ? [{ id: "git", label: "Git" }] : []),
  ];

  return (
    <ProjectFrame>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-muted-foreground hover:underline">
            ← All projects
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{project.slug}</h1>
          <p className="font-mono text-xs text-muted-foreground">
            {project.path} · {apps.length} {apps.length === 1 ? "app" : "apps"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RescanProjectButton slug={project.slug} />
          {!project.archived && <DeleteProjectButton slug={project.slug} />}
        </div>
      </div>

      {project.archived && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-amber-900 dark:text-amber-200">
            This project is removed from the dashboard. Its files on disk are untouched.
          </span>
          <RestoreProjectButton slug={project.slug} />
        </div>
      )}

      <div className="space-y-4">
        <ProjectTabNav slug={project.slug} tabs={tabs} />
        {children}
      </div>
    </ProjectFrame>
  );
}
