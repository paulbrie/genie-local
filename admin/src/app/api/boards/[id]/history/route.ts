import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { boardsHub, getBoard, parseBoardId } from "@/lib/boards/db";
import { getSnapshot, listHistory } from "@/lib/boards/history";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A board's history. Without `?at=<snapshot id>` it lists the points you can go
 * back to (oldest first); with it, the board exactly as it stood then.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if (!(await getBoard(id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const at = req.nextUrl.searchParams.get("at");
  if (at) {
    const snapId = Number(at);
    const doc = Number.isInteger(snapId) ? await getSnapshot(id, snapId) : null;
    if (!doc) return NextResponse.json({ error: "no such point in this board's history" }, { status: 404 });
    return NextResponse.json({ doc }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(await listHistory(id), { headers: { "Cache-Control": "no-store" } });
}

const restoreSchema = z.object({ at: z.number().int().positive() });

/** Put the board back as it was at a point in its history, for everyone on it. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const hub = boardsHub();
  if (!hub) return NextResponse.json({ error: "the board hub isn't running" }, { status: 503 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = restoreSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const doc = await getSnapshot(id, parsed.data.at);
  if (!doc) return NextResponse.json({ error: "no such point in this board's history" }, { status: 404 });
  // Keep where we were, so restoring is itself undoable.
  await hub.snapshotBoard(id, "before going back");
  if (!(await hub.replaceDoc(id, doc))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
