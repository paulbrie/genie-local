import "server-only";

import { NextResponse } from "next/server";

import { getResolvedConnection, type ResolvedConnection } from "@/lib/connections";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveConn(idStr: string): Promise<ResolvedConnection> {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad connection id");
  const conn = await getResolvedConnection(id);
  if (!conn) throw new HttpError(404, "connection not found");
  return conn;
}

/** Turn any thrown error into a JSON response (502 for driver errors). */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status: 502 });
}
