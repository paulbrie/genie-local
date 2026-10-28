import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/require-admin";
import { isHistoryRange, readProjectMemoryHistory } from "@/lib/stats-history";

export const dynamic = "force-dynamic";

/** One project's memory over `?range=1d|7d|30d` (default 1d), from the per-minute history: `?slug=<project>`. */
export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const slug = params.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const param = params.get("range") ?? "1d";
  const range = isHistoryRange(param) ? param : "1d";
  return NextResponse.json(await readProjectMemoryHistory(slug, range), { headers: { "Cache-Control": "no-store" } });
}
