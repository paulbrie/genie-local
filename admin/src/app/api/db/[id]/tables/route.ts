import { NextResponse } from "next/server";

import { listTables } from "@/lib/db-explorer";
import { errorResponse, HttpError, resolveConn } from "@/lib/db-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const database = new URL(req.url).searchParams.get("database");
    if (!database) throw new HttpError(400, "database is required");
    return NextResponse.json(await listTables(conn, database));
  } catch (e) {
    return errorResponse(e);
  }
}
