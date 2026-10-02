import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError, resolveConn } from "@/lib/db-route-helpers";
import { createSavedQuery, listSavedQueries } from "@/lib/saved-queries";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const database = new URL(req.url).searchParams.get("database");
    if (!database) throw new HttpError(400, "database is required");
    return NextResponse.json(await listSavedQueries(conn.id, database));
  } catch (e) {
    return errorResponse(e);
  }
}

const schema = z.object({
  database: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  sql: z.string().trim().min(1).max(100_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const body = schema.parse(await req.json());
    const row = await createSavedQuery(
      conn.id,
      body.database,
      body.name,
      body.sql,
    );
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
