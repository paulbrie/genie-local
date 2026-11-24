import { notFound } from "next/navigation";

import { RailwayPanel } from "@/components/railway-panel";
import { getProject } from "@/lib/project-page";
import { hasBoxToken, railwayLink } from "@/lib/railway-project";

export const dynamic = "force-dynamic";

/** /projects/<slug>/railway: the project on Railway (its services, production issues, deployments and their logs). */
export default async function ProjectRailwayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const link = await railwayLink(detail.project.slug);
  return (
    <RailwayPanel
      slug={detail.project.slug}
      boxToken={hasBoxToken()}
      initial={link ? { ...link, collectedUntil: link.collectedUntil?.toISOString() ?? null, updatedAt: link.updatedAt.toISOString() } : null}
    />
  );
}
