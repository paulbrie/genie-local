import { NextResponse } from "next/server";

import { testConnection } from "@/lib/db-explorer";
import { errorResponse, resolveConn } from "@/lib/db-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const error = await testConnection(conn);
    return NextResponse.json({ ok: error === null, error });
  } catch (e) {
    return errorResponse(e);
  }
}
