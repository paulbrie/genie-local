import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { createBoard, listBoards } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  createdBy: z.string().trim().max(60).optional(),
  // Optional starting content: a doc as returned by GET /api/boards/<id>.
  doc: z.record(z.string(), z.unknown()).optional(),
});

/**
 * List boards (most recently edited first); `?archived=true` for archived ones.
 * Auth via proxy.ts (session cookie, or x-api-key = BOARDS_API_KEY for agents).
 */
export async function GET(req: NextRequest) {
  const archived = req.nextUrl.searchParams.get("archived") === "true";
  return NextResponse.json(await listBoards(archived), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Create a board from `{ title, createdBy?, doc? }`. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { title, createdBy, doc } = parsed.data;
  return NextResponse.json(await createBoard(title, createdBy ?? null, doc), { status: 201 });
}
