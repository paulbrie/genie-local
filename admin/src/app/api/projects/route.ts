// GET: active projects with a running flag and open / in-progress ticket
// counts, for the sidebar's Projects list.
import { NextResponse } from "next/server";

import { getProjectNav } from "@/lib/dashboard-metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { projects: await getProjectNav() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
