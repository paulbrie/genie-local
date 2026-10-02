import { NextResponse } from "next/server";

import { listLogs } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** List the log files under LOGS_ROOT (default /tmp), newest first. */
export async function GET() {
  const files = await listLogs();
  return NextResponse.json(
    { files },
    { headers: { "Cache-Control": "no-store" } },
  );
}
