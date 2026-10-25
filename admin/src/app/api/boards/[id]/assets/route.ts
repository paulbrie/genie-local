import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { saveBoardAsset } from "@/lib/boards/assets";
import { getBoard, parseBoardId } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Upload an image for a board (multipart `file`); returns `{ src }` for an image object. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if (!(await getBoard(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
  try {
    return NextResponse.json(await saveBoardAsset(id, file), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
