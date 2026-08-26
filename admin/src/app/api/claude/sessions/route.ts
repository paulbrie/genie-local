import { NextResponse } from "next/server";

import { listSessions } from "@/lib/claude";

export const dynamic = "force-dynamic";

/** List every Claude Code session across projects, newest activity first. */
export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json(
    { sessions },
    { headers: { "Cache-Control": "no-store" } },
  );
}
