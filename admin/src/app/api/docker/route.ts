import { NextResponse } from "next/server";

import { listDocker } from "@/lib/docker";

export const dynamic = "force-dynamic";

/** Containers (all) + images from the local Docker daemon. Auth via proxy.ts. */
export async function GET() {
  const data = await listDocker();
  return NextResponse.json(data, {
    status: data.available ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
