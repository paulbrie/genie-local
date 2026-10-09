import { NextResponse } from "next/server";

import { DEFAULT_DAYS, getCommsModel } from "@/lib/claude-comms";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Messages between Claude Code sessions, with the tasks, file claims and
 * commits read from them. Redacted; never returns raw transcript lines.
 *
 * GET /api/claude/comms?days=7&v=<version>
 * When `v` matches the current version the body is just `{ unchanged: true }`,
 * so the page can poll cheaply.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get("days")) || DEFAULT_DAYS;
  const model = await getCommsModel(days);
  if (searchParams.get("v") === model.version)
    return NextResponse.json({ unchanged: true, version: model.version }, noStore);
  return NextResponse.json(model, noStore);
}
