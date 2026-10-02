import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  archiveDiagram,
  DIAGRAM_FORMATS,
  getDiagram,
  MAX_DIAGRAM_BYTES,
  purgeDiagram,
  restoreDiagram,
  updateDiagram,
} from "@/lib/diagrams";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    source: z.string().min(1).max(MAX_DIAGRAM_BYTES).optional(),
    format: z.enum(DIAGRAM_FORMATS).optional(),
    // Soft-delete toggle: false restores, true archives.
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** One diagram by id. Auth via proxy.ts. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const row = await getDiagram(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row, { headers: { "Cache-Control": "no-store" } });
}

/** Update a diagram's title/source/format from a JSON patch. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { archived, ...fields } = parsed.data;
  // Archive/restore is a separate state change from a content edit; apply it
  // first, then any title/source/format update.
  if (archived === true) await archiveDiagram(id);
  else if (archived === false) await restoreDiagram(id);
  const row =
    Object.keys(fields).length > 0
      ? await updateDiagram(id, fields)
      : await getDiagram(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

/**
 * Delete a diagram. Soft-deletes (archives) by default; pass `?purge=true` for
 * a permanent, irreversible delete.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const purge = req.nextUrl.searchParams.get("purge") === "true";
  if (purge) await purgeDiagram(id);
  else await archiveDiagram(id);
  return new NextResponse(null, { status: 204 });
}
