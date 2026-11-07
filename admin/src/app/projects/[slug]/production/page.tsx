import { notFound } from "next/navigation";

import { ProductionPanel } from "@/components/production-panel";
import { getProduction } from "@/lib/data";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/production: where the project runs in production. */
export default async function ProjectProductionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const row = await getProduction(detail.project.id);
  return (
    <ProductionPanel
      slug={detail.project.slug}
      initial={row ? { url: row.url, notes: row.notes, updatedAt: row.updatedAt.toISOString() } : null}
    />
  );
}
