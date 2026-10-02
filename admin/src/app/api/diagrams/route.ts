import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  createDiagram,
  DIAGRAM_FORMATS,
  listArchivedDiagrams,
  listDiagrams,
  MAX_DIAGRAM_BYTES,
} from "@/lib/diagrams";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  source: z.string().min(1).max(MAX_DIAGRAM_BYTES),
  format: z.enum(DIAGRAM_FORMATS).default("mermaid"),
});

/**
 * List saved diagrams (newest first). Active by default; `?archived=true`
 * returns the soft-deleted ones. Auth via proxy.ts.
 */
export async function GET(req: NextRequest) {
  const archived = req.nextUrl.searchParams.get("archived") === "true";
  const rows = archived ? await listArchivedDiagrams() : await listDiagrams();
  return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Create a diagram from JSON `{ title, source, format? }`. This is the
 * agent-facing entry point: an agent writes Mermaid source and POSTs it here.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const row = await createDiagram(parsed.data);
  return NextResponse.json(row, { status: 201 });
}
