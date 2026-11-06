import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { browserBridge } from "@/lib/browsers/db";
import { readSessionToken, SESSION_COOKIE, sessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A single-use code (10 minutes) to type into the extension's popup, which pairs that browser. */
export async function POST(req: NextRequest) {
  const hub = browserBridge();
  if (!hub) return NextResponse.json({ error: "the browser bridge runs only under server.mjs" }, { status: 503 });
  const session = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  const createdBy = session ? (sessionEmail(session.sub) ?? session.sub) : "agent";
  return NextResponse.json(hub.createPairCode(createdBy));
}
