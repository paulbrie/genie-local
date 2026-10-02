import { NextResponse } from "next/server";

import { listChromeInstances } from "@/lib/chrome";

export const dynamic = "force-dynamic";

/** List running Chrome instances grouped by user-data-dir. Auth via proxy.ts. */
export async function GET() {
  const instances = await listChromeInstances();
  const totalMemMB = instances.reduce((s, i) => s + i.memMB, 0);
  return NextResponse.json(
    { instances, totalMemMB, ts: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
