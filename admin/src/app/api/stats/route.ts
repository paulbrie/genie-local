import { NextResponse } from "next/server";

import { readLatestStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

/**
 * Latest CPU/mem/disk snapshot for the top toolbar and the Table's dials (polled), with per-core CPU (`cpuPerCore`),
 * and for the Ops view's server rack the bandwidth in/out (`net`) and the public ports (`ports`) (T211).
 */
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
