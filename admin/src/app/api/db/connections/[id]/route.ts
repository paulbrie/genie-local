import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteConnection, updateConnection } from "@/lib/connections";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  engine: z.enum(["postgres", "mysql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  // omit password to keep the existing one; null clears it
  password: z.string().max(1024).nullable().optional(),
  defaultDatabase: z.string().trim().max(255).nullable().optional(),
});

async function parseId(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  return z.coerce.number().int().positive().parse(id);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = await parseId(params);
  const body = updateSchema.parse(await request.json());
  const conn = await updateConnection(id, body);
  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(conn);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await deleteConnection(await parseId(params));
  return NextResponse.json({ ok: true });
}
