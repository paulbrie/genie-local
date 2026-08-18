import { NextResponse } from "next/server";

import { listServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/** systemd service units + enabled state. Auth is enforced by proxy.ts. */
export async function GET() {
  const data = await listServices();
  return NextResponse.json(data, {
    status: data.available ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
