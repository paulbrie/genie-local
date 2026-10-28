// POST /api/files/upload {dir, name, size, overwrite?, project?}: starts a chunked upload (T243); see lib/files/uploads.
import { NextRequest, NextResponse } from "next/server";

import { assertWritable, resolveNew, scopeRoots } from "@/lib/files/guard";
import { audit } from "@/lib/files/ops";
import { CHUNK_BYTES, startUpload } from "@/lib/files/uploads";
import { errorResponse, whoOf } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { dir?: string; name?: string; size?: number; overwrite?: boolean; project?: string };
    const overwrite = body.overwrite === true;
    const t = await resolveNew(body.dir ?? "", body.name ?? "", scopeRoots(typeof body.project === "string" ? body.project : null), overwrite);
    await assertWritable(t.dir);
    const s = await startUpload(t.abs, Number(body.size), overwrite);
    audit("upload-start", { path: t.abs, bytes: s.size, overwrite, id: s.id }, whoOf(req));
    return NextResponse.json({ id: s.id, size: s.size, received: 0, chunkBytes: CHUNK_BYTES });
  } catch (err) {
    return errorResponse(err);
  }
}
