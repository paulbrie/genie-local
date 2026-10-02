import { NextResponse } from "next/server";

import { readMemory } from "@/lib/claude";

export const dynamic = "force-dynamic";

/** Raw markdown of one memory file: ?path=<rel-to-claude-home>. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rel = url.searchParams.get("path");
  if (!rel) {
    return NextResponse.json({ error: "missing path" }, { status: 400 });
  }

  let content;
  try {
    content = await readMemory(rel);
  } catch {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  if (content == null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ content }, { headers: { "Cache-Control": "no-store" } });
}
