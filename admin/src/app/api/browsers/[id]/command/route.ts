import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { browserBridge, parseBrowserId } from "@/lib/browsers/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  type: z.string().min(1).max(40),
  args: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(180_000).optional(),
});

/**
 * Run one command in a paired browser: `{ type, args, timeoutMs? }`, e.g.
 * `{ type: "click", args: { tabId, ref: "e12" } }`. Answers `{ ok: true, data }`
 * or `{ ok: false, error }` (still 200: the browser was reached, it said no).
 * The commands are listed in extension/background.js.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = parseBrowserId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const hub = browserBridge();
  if (!hub) return NextResponse.json({ error: "the browser bridge runs only under server.mjs" }, { status: 503 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  const { type, args, timeoutMs } = parsed.data;
  try {
    return NextResponse.json({ ok: true, data: await hub.command(id, type, args ?? {}, timeoutMs) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
