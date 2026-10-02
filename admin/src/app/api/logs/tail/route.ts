import { NextResponse } from "next/server";

import { DEFAULT_TAIL_BYTES, readLogTail } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** Return the tail of a single log file: /api/logs/tail?file=<rel>&bytes=<n>. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  const bytesParam = Number(url.searchParams.get("bytes"));
  const bytes = Number.isFinite(bytesParam) && bytesParam > 0
    ? bytesParam
    : DEFAULT_TAIL_BYTES;

  let tail;
  try {
    tail = await readLogTail(file, bytes);
  } catch {
    // resolveLogPath rejected the path (traversal / non-log extension).
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  if (!tail) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(tail, { headers: { "Cache-Control": "no-store" } });
}
