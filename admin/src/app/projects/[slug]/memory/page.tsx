import { notFound } from "next/navigation";

import { ProjectMemoryPanel } from "@/components/project-memory-panel";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/memory */
export default async function ProjectMemoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  return <ProjectMemoryPanel slug={detail.project.slug} />;
}
