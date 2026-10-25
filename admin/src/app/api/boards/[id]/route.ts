import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { describeBoard } from "@/lib/boards/core.mjs";
import {
  archiveBoard,
  boardsHub,
  getBoard,
  parseBoardId,
  purgeBoard,
  renameBoard,
  restoreBoard,
} from "@/lib/boards/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

/**
 * One board. JSON with the full `doc`, who's on it, and `text`: one compact
 * JSON line per object (what agents should read). `?format=text` returns only
 * those lines as text/plain.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const row = await getBoard(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const text = describeBoard(row.doc, { names: true });
  if (req.nextUrl.searchParams.get("format") === "text") {
    return new NextResponse(`# ${row.title}\n${text}\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(
    { ...row, text, participants: boardsHub()?.participants(id) ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Rename (`title`) and/or archive / restore (`archived`). */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { title, archived } = parsed.data;
  if (title !== undefined && !(await renameBoard(id, title))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (archived === true) await archiveBoard(id);
  if (archived === false) await restoreBoard(id);
  return NextResponse.json({ ok: true });
}

/** Permanently delete a board; it has to be archived first. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if (!(await purgeBoard(id))) {
    return NextResponse.json({ error: "not found or not archived" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
