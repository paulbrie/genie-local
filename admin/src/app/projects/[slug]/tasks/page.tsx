import { notFound } from "next/navigation";

import { TaskBoard } from "@/components/task-board";
import { getTaskAttachments, getTaskComments, getTasks } from "@/lib/data";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/tasks: the kanban board (`?task=<id>` opens that ticket). */
export default async function ProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ task?: string | string[] }>;
}) {
  const { slug } = await params;
  const { task } = await searchParams;
  const openFirst = Number(Array.isArray(task) ? task[0] : task) || undefined;
  const detail = await getProject(slug);
  if (!detail) notFound();
  const { project } = detail;
  const [tasks, comments, attachments] = await Promise.all([
    getTasks(project.id),
    getTaskComments(project.id),
    getTaskAttachments(project.id),
  ]);
  return (
    <TaskBoard slug={project.slug} tasks={tasks} comments={comments} attachments={attachments} openFirst={openFirst} />
  );
}
