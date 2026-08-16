import { NextResponse } from "next/server";

import { listRunning } from "@/lib/runner";

export const dynamic = "force-dynamic";

/**
 * Apps whose dev/prod process is currently alive: their run-slugs plus the
 * resident memory (bytes) of each one's process group, keyed by slug.
 */
export async function GET() {
  const runs = await listRunning();
  return NextResponse.json(
    {
      running: runs.map((r) => r.slug),
      memory: Object.fromEntries(runs.map((r) => [r.slug, r.rssBytes])),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
