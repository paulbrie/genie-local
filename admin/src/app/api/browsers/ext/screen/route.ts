import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { extLink } from "@/lib/browsers/ext";
import { paneExcerpt, parseChoices } from "@/lib/slack/core";
import { captureTerminal, listTerminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

/** What a terminal shows now (its last lines, read like the Slack bot reads them) and the choice it waits on, if any. */
export async function GET(req: NextRequest) {
  if (!(await extLink(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const name = req.nextUrl.searchParams.get("terminal") ?? "";
  const t = (await listTerminals()).find((x) => x.name === name);
  if (!t) return NextResponse.json({ error: `there's no terminal "${name}"` }, { status: 404 });
  const cap = await captureTerminal(name);
  return NextResponse.json(
    {
      name,
      status: cap.status,
      dead: t.dead,
      text: paneExcerpt(cap.content, cap.status, 80, 8000),
      choices: cap.status === "claude-input" ? parseChoices(cap.content) : [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
