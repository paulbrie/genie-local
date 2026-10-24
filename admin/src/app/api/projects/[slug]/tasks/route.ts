// POST multipart `title`, `description` (optional) and `files` (optional, one
// or more): a new ticket with its files, in one request. For a project's own
// app to file tickets from its pages (trafficsim's Claude bridge panel): served
// on the same host, the browser sends the admin's session cookie with it.
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { addTask, getProjectIdBySlug, insertTaskAttachments } from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { saveAttachment } from "@/lib/task-attachments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** The longest description kept inline (as the Tasks tab's form); longer goes to a .txt file, an excerpt kept. */
const TEXT_LIMIT = 5000;
const EXCERPT = 1500;

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const projectId = await getProjectIdBySlug(slug);
  if (projectId == null) {
    return NextResponse.json({ error: "no such project" }, { status: 404 });
  }
  try {
    const form = await req.formData();
    const title = z.string().trim().min(1).max(500).safeParse(form.get("title"));
    if (!title.success) {
      return NextResponse.json({ error: "a title is needed (at most 500 characters)" }, { status: 400 });
    }
    const raw = form.get("description");
    let description = typeof raw === "string" ? raw.trim() : "";
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (description.length > TEXT_LIMIT) {
      const name = `description-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
      files.push(new File([description], name, { type: "text/plain" }));
      description = `${description.slice(0, EXCERPT).trimEnd()}\n\n… ${description.length.toLocaleString("en")} characters in all: the full text is attached as ${name}.`;
    }
    const taskId = await addTask(projectId, title.data, description || null);
    // (the ticket stands even if a file can't be kept: said, so it isn't filed twice)
    const saved = [];
    let fileError: string | undefined;
    try {
      for (const file of files) saved.push(await saveAttachment(taskId, file));
    } catch (err) {
      fileError = err instanceof Error ? err.message : "a file couldn't be saved";
    }
    await insertTaskAttachments(saved.map((s) => ({ ...s, taskId, author: "user" })));
    revalidatePath("/projects/[slug]", "layout");
    return NextResponse.json({
      id: taskId,
      attached: saved.length,
      ...(fileError ? { fileError } : {}),
      url: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/projects/${encodeURIComponent(slug)}/tasks`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "couldn't create the ticket" },
      { status: 400 },
    );
  }
}
