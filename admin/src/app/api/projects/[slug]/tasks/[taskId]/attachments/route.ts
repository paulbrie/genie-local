// POST multipart `files` (one or more): attach them to the task (uploaded or
// pasted from the clipboard in the Tasks tab). A route handler rather than a
// server action so large files aren't held to the action body limit.
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

import {
  getProjectIdBySlug,
  insertTaskAttachments,
  taskInProject,
} from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { saveAttachment } from "@/lib/task-attachments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; taskId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { slug, taskId: rawTaskId } = await params;
  const taskId = Number(rawTaskId);
  const projectId = await getProjectIdBySlug(slug);
  if (
    projectId == null ||
    !Number.isInteger(taskId) ||
    !(await taskInProject(projectId, taskId))
  ) {
    return NextResponse.json({ error: "no such task" }, { status: 404 });
  }
  try {
    const files = (await req.formData())
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (!files.length) {
      return NextResponse.json({ error: "no files" }, { status: 400 });
    }
    const saved = [];
    for (const file of files) saved.push(await saveAttachment(taskId, file));
    await insertTaskAttachments(
      saved.map((s) => ({ ...s, taskId, author: "user" })),
    );
    revalidatePath("/projects/[slug]", "layout");
    return NextResponse.json({ attached: saved.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upload failed" },
      { status: 400 },
    );
  }
}
