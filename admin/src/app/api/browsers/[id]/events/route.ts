import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { browserBridge, parseBrowserId } from "@/lib/browsers/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What happened in a browser's shared tabs (console messages, page errors,
 * navigations, dialogs, tabs shared and unshared, connects): the events after
 * `?after=<seq>`, waiting up to `?wait=<seconds>` (max 60) for one.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const id = parseBrowserId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const hub = browserBridge();
  if (!hub) return NextResponse.json({ error: "the browser bridge runs only under server.mjs" }, { status: 503 });
  const sp = req.nextUrl.searchParams;
  const after = Math.max(0, Number(sp.get("after")) || 0);
  const wait = Math.min(60, Math.max(0, Number(sp.get("wait")) || 0));
  return NextResponse.json(await hub.events(id, after, wait * 1000), { headers: { "Cache-Control": "no-store" } });
}
