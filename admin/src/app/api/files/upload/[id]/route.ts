// /api/files/upload/<id>: PUT ?offset=N with a chunk as the body (at most CHUNK_BYTES); GET what the server has (to
// resume); POST to finish (renamed into place); DELETE to cancel (T243).
import { NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/files/ops";
import { cancelUpload, CHUNK_BYTES, completeUpload, getSession, UploadError, writeChunk } from "@/lib/files/uploads";
import { errorResponse, whoOf } from "../../shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const s = await getSession((await params).id);
    return NextResponse.json({ id: s.id, size: s.size, received: s.received });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > CHUNK_BYTES) throw new UploadError("chunk too big", 413);
    const chunk = new Uint8Array(await req.arrayBuffer());
    const s = await writeChunk(id, Number(req.nextUrl.searchParams.get("offset")), chunk);
    return NextResponse.json({ received: s.received, size: s.size });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const done = await completeUpload(id);
    audit("upload", { path: done.path, bytes: done.size, id }, whoOf(req));
    return NextResponse.json(done);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    await cancelUpload(id);
    audit("upload-cancel", { id }, whoOf(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
