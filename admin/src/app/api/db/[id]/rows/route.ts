import { NextResponse } from "next/server";
import { z } from "zod";

import {
  deleteRow,
  getRows,
  insertRow,
  updateRow,
} from "@/lib/db-explorer";
import { errorResponse, HttpError, resolveConn } from "@/lib/db-route-helpers";

export const dynamic = "force-dynamic";

/** Browse rows: ?database=&table=&limit=&offset=&orderBy=&dir= */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const sp = new URL(req.url).searchParams;
    const database = sp.get("database");
    const table = sp.get("table");
    if (!database || !table) throw new HttpError(400, "database and table required");
    const result = await getRows(conn, database, table, {
      limit: Number(sp.get("limit") ?? 50),
      offset: Number(sp.get("offset") ?? 0),
      orderBy: sp.get("orderBy") ?? undefined,
      dir: sp.get("dir") === "desc" ? "desc" : "asc",
    });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

const writeBase = z.object({
  database: z.string().min(1),
  table: z.string().min(1),
  values: z.record(z.string(), z.unknown()),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const body = writeBase.parse(await req.json());
    await insertRow(conn, body.database, body.table, body.values);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

const editSchema = writeBase.extend({
  pk: z.record(z.string(), z.unknown()),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const body = editSchema.parse(await req.json());
    if (Object.keys(body.pk).length === 0)
      throw new HttpError(400, "primary key required to edit a row");
    await updateRow(conn, body.database, body.table, body.pk, body.values);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

const deleteSchema = z.object({
  database: z.string().min(1),
  table: z.string().min(1),
  pk: z.record(z.string(), z.unknown()),
});

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const conn = await resolveConn((await params).id);
    const body = deleteSchema.parse(await req.json());
    if (Object.keys(body.pk).length === 0)
      throw new HttpError(400, "primary key required to delete a row");
    await deleteRow(conn, body.database, body.table, body.pk);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
