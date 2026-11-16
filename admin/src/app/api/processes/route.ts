import { NextResponse } from "next/server";

import { readAncestors } from "@/lib/processes";
import { readLatestProcesses } from "@/lib/stats";

export const dynamic = "force-dynamic";

/**
 * Latest process list + open ports from the vps-stats daemon (its busiest processes only), and `ancestors`: those
 * above them it didn't record, from /proc, so they can be drawn as a tree.
 */
export async function GET() {
  const data = await readLatestProcesses();
  if (!data) {
    return NextResponse.json(
      { error: "process stats unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({ ...data, ancestors: await readAncestors(data.processes) }, {
    headers: { "Cache-Control": "no-store" },
  });
}
