import { NextResponse } from "next/server";

import { isHistoryRange, readMemoryDistribution } from "@/lib/stats-history";

export const dynamic = "force-dynamic";

/** Memory over a period (`?range=1d|7d|30d`, 30 days by default): every project's, its agents', and what's used (the desktop's Memory widget). */
export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("range") ?? "30d";
  return NextResponse.json(await readMemoryDistribution(isHistoryRange(param) ? param : "30d"));
}
