import { NextResponse } from "next/server";

import { getTranscript } from "@/lib/claude";

export const dynamic = "force-dynamic";

/** Rendered transcript of one session: ?project=<dir>&id=<uuid>. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const id = url.searchParams.get("id");
  if (!project || !id) {
    return NextResponse.json({ error: "missing project/id" }, { status: 400 });
  }

  let messages;
  try {
    messages = await getTranscript(project, id);
  } catch {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  if (!messages) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
}
