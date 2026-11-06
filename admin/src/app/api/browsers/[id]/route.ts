import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { browserBridge, parseBrowserId, renameBrowser, revokeBrowser } from "@/lib/browsers/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** One connected browser, live: its tabs. 404 when it isn't connected. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const id = parseBrowserId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const live = browserBridge()?.get(id);
  if (!live) return NextResponse.json({ error: "not connected" }, { status: 404 });
  return NextResponse.json(live, { headers: { "Cache-Control": "no-store" } });
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(80) });

/** Rename `{ name }`. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = parseBrowserId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  if (!(await renameBrowser(id, parsed.data.name))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Unpair: its token stops working, and it's disconnected now. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const id = parseBrowserId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if (!(await revokeBrowser(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
