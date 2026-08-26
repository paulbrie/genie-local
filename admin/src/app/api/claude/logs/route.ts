import { NextResponse } from "next/server";

import { listLogs } from "@/lib/claude";

export const dynamic = "force-dynamic";

/** List log-like files under ~/.claude (session JSONL, debug logs), newest first. */
export async function GET() {
  const files = await listLogs();
  return NextResponse.json(
    { files },
    { headers: { "Cache-Control": "no-store" } },
  );
}
