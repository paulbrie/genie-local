import { NextResponse } from "next/server";
import { z } from "zod";

import { runQuery } from "@/lib/db-explorer";
import { errorResponse, resolveConn } from "@/lib/db-route-helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  database: z.string().min(1),
  sql: z.string().trim().min(1).max(100_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const { database, sql } = schema.parse(await req.json());
    return NextResponse.json(await runQuery(conn, database, sql));
  } catch (e) {
    return errorResponse(e);
  }
}
