import { notFound } from "next/navigation";

import { GitGraphView } from "@/components/git-graph";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/git[?app=<app>]: the history; a commit opens /git/<hash>. */
export default async function ProjectGitPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ app?: string | string[] }>;
}) {
  const { slug } = await params;
  const { app } = await searchParams;
  const detail = await getProject(slug);
  if (!detail || !detail.apps.some(({ app: a }) => a.isGit)) notFound();
  return (
    <GitGraphView
      projectSlug={detail.project.slug}
      initialApp={Array.isArray(app) ? app[0] : app}
    />
  );
}
