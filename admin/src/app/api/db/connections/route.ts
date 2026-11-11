import { NextResponse } from "next/server";
import { z } from "zod";

import { createConnection, listConnections } from "@/lib/connections";
import { forgetFound, foundConnections } from "@/lib/db-discovery";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  engine: z.enum(["postgres", "mysql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  password: z.string().max(1024).nullable().optional(),
  defaultDatabase: z.string().trim().max(255).nullable().optional(),
});

/** Every connection: the ones added by hand, and the databases found on this box (looked for at most every 30 s). */
export async function GET() {
  // (if looking fails, the ones already known still list)
  const found = await foundConnections().catch(() => undefined);
  return NextResponse.json(await listConnections(found));
}

export async function POST(request: Request) {
  const body = inputSchema.parse(await request.json());
  const conn = await createConnection(body);
  forgetFound();
  return NextResponse.json(conn, { status: 201 });
}
