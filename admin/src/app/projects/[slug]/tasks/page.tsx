import { notFound } from "next/navigation";

import { TaskBoard } from "@/components/task-board";
import { getTaskAttachments, getTaskComments, getTasks } from "@/lib/data";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/tasks: the kanban board. */
export default async function ProjectTasksPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const { project } = detail;
  const [tasks, comments, attachments] = await Promise.all([
    getTasks(project.id),
    getTaskComments(project.id),
    getTaskAttachments(project.id),
  ]);
  return (
    <TaskBoard slug={project.slug} tasks={tasks} comments={comments} attachments={attachments} />
  );
}
