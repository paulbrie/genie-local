import { NextResponse } from "next/server";

import { readLatestProcesses } from "@/lib/stats";

export const dynamic = "force-dynamic";

/** Latest process list + open ports from the vps-stats daemon. */
export async function GET() {
  const data = await readLatestProcesses();
  if (!data) {
    return NextResponse.json(
      { error: "process stats unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
