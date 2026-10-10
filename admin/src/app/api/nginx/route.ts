import { NextResponse } from "next/server";

import { listNginxFiles } from "@/lib/nginx-config";

export const dynamic = "force-dynamic";

/** List the editable Nginx config files. Auth is enforced by proxy.ts. */
export async function GET() {
  const data = await listNginxFiles();
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
