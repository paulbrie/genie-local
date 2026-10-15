// GET a task attachment's bytes. Images, PDFs and plain text open inline; any
// other type (HTML, SVG…) downloads so it can't run on the admin origin.
import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { getTaskAttachment } from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { attachmentAbsPath, isInlineType } from "@/lib/task-attachments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = Number((await params).id);
  const att = Number.isInteger(id) ? await getTaskAttachment(id) : null;
  if (!att) return NextResponse.json({ error: "not found" }, { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(attachmentAbsPath(att.path));
  } catch {
    return NextResponse.json({ error: "file missing" }, { status: 404 });
  }
  const inline = isInlineType(att.mime);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": inline ? att.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
