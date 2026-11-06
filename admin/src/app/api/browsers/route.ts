import { NextResponse } from "next/server";

import { listBrowsers } from "@/lib/browsers/db";

export const dynamic = "force-dynamic";

/**
 * Browsers paired with the Spiridus Bridge extension: whether each is connected,
 * and the tabs it shares. Auth via proxy.ts (session cookie, or x-api-key =
 * BROWSERS_API_KEY for agents).
 */
export async function GET() {
  return NextResponse.json({ browsers: await listBrowsers() }, { headers: { "Cache-Control": "no-store" } });
}
