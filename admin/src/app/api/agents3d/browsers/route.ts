import { NextResponse } from "next/server";

import { listBrowserSessions } from "@/lib/browsers";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents3d/browsers: the open agent-browser sessions, who they belong
 * to, their Chrome's CPU / memory / start and the page's title and host (see
 * lib/browsers.ts). Read only; polled by Agents City (~5 s, not while hidden).
 */
export async function GET() {
  return NextResponse.json(await listBrowserSessions(), { headers: { "Cache-Control": "no-store" } });
}
