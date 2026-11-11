import { NextResponse } from "next/server";

import { gitData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Git: every repo's branch, how far from its upstream, and what's changed (asked of git every 30 s at most). */
export async function GET() {
  return NextResponse.json(await gitData());
}
