import { NextResponse } from "next/server";

import { isHistoryRange, readStatsHistory } from "@/lib/stats-history";

export const dynamic = "force-dynamic";

/**
 * Downsampled CPU/MEM/DISK history for the top-bar graph. `?range=1d|7d|30d`
 * (defaults to 1d). Backed by the persistent file the cron sampler writes, so it
 * works even when the live-stats feed has only just started.
 */
export async function GET(request: Request) {
  const param = new URL(request.url).searchParams.get("range") ?? "1d";
  const range = isHistoryRange(param) ? param : "1d";
  const history = await readStatsHistory(range);
  return NextResponse.json(history, {
    headers: { "Cache-Control": "no-store" },
  });
}
