import { notFound } from "next/navigation";

import { VercelPanel } from "@/components/vercel-panel";
import { getProject } from "@/lib/project-page";
import { vercelLink } from "@/lib/vercel";

export const dynamic = "force-dynamic";

/** /projects/<slug>/vercel: the project on Vercel (its token, deployments, build and runtime logs). */
export default async function ProjectVercelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const link = await vercelLink(detail.project.slug);
  return <VercelPanel slug={detail.project.slug} initial={link ? { ...link, updatedAt: link.updatedAt.toISOString() } : null} />;
}
