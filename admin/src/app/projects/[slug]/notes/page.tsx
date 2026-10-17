import { notFound } from "next/navigation";

import { NotesPanel } from "@/components/notes-panel";
import { getNotes } from "@/lib/data";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/notes */
export default async function ProjectNotesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  return <NotesPanel slug={detail.project.slug} notes={await getNotes(detail.project.id)} />;
}
