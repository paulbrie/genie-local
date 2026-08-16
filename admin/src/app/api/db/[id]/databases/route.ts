import { NextResponse } from "next/server";

import { listDatabases } from "@/lib/db-explorer";
import { errorResponse, resolveConn } from "@/lib/db-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    return NextResponse.json({
      engine: conn.engine,
      defaultDatabase: conn.defaultDatabase,
      databases: await listDatabases(conn),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
