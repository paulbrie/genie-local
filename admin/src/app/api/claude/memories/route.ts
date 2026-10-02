import { NextResponse } from "next/server";

import { listMemories } from "@/lib/claude";

export const dynamic = "force-dynamic";

/** List every agent memory file across projects, newest first. */
export async function GET() {
  const memories = await listMemories();
  return NextResponse.json(
    { memories },
    { headers: { "Cache-Control": "no-store" } },
  );
}
