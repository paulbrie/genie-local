import { notFound } from "next/navigation";

import { CodeReviewPanel } from "@/components/code-review-panel";
import { GitGraphView } from "@/components/git-graph";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/git[?app=<app>][&view=branch:<b>|wt:<path>]: the history; a commit opens /git/<hash>. */
export default async function ProjectGitPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ app?: string | string[]; view?: string | string[] }>;
}) {
  const { slug } = await params;
  const { app, view } = await searchParams;
  const detail = await getProject(slug);
  if (!detail || !detail.apps.some(({ app: a }) => a.isGit)) notFound();
  return (
    <div className="space-y-3">
      <CodeReviewPanel slug={detail.project.slug} />
      <GitGraphView
        projectSlug={detail.project.slug}
        initialApp={Array.isArray(app) ? app[0] : app}
        initialView={Array.isArray(view) ? view[0] : view}
      />
    </div>
  );
}
