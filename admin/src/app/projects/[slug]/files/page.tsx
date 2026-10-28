import { notFound } from "next/navigation";

import { FileExplorer } from "@/components/files/file-explorer";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/**
 * /projects/<slug>/files: the file explorer rooted at the project's folder (the API holds this view to it), text files
 * editable where the admin may change them.
 */
export default async function ProjectFilesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-[480px] flex-col">
      <FileExplorer project={detail.project.slug} />
    </div>
  );
}
