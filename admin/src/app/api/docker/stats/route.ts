import { NextResponse } from "next/server";

import { dockerStatsSummary } from "@/lib/docker";

export const dynamic = "force-dynamic";

/** Running-container count + combined memory, for the sidebar badge. */
export async function GET() {
  const data = await dockerStatsSummary();
  return NextResponse.json(data, {
    status: data.available ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
