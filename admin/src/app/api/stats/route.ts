import { NextResponse } from "next/server";

import { readLatestStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

/** Latest CPU/mem/disk snapshot for the top toolbar (polled by the client). */
export async function GET() {
  const stats = await readLatestStats();
  if (!stats) {
    return NextResponse.json(
      { error: "stats unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(stats, {
    headers: { "Cache-Control": "no-store" },
  });
}
