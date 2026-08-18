import { NextResponse } from "next/server";

import { containerLogs, isDockerId } from "@/lib/docker";

export const dynamic = "force-dynamic";

/** Tail a container's logs. `?id=<hex>&tail=<n>`. Auth via proxy.ts. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const tail = Number(url.searchParams.get("tail") ?? "500");

  if (!isDockerId(id)) {
    return NextResponse.json({ error: "invalid container id" }, { status: 400 });
  }

  const result = await containerLogs(id, Number.isFinite(tail) ? tail : 500);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
