import { NextResponse } from "next/server";

import { getRunningInfo } from "@/lib/app-run-status";

export const dynamic = "force-dynamic";

/**
 * Apps whose dev/prod process is currently alive: their run-slugs plus the
 * resident memory (bytes) of each one's process group, keyed by slug. "Alive"
 * means a tracked pid OR something listening on the app's port (see
 * getRunningInfo), so servers started outside the runner still register.
 */
export async function GET() {
  const runs = await getRunningInfo();
  return NextResponse.json(
    {
      running: runs.map((r) => r.slug),
      memory: Object.fromEntries(runs.map((r) => [r.slug, r.rssBytes])),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
