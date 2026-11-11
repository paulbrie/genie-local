import { NextResponse } from "next/server";

import { errorsData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Production errors: the open Vercel issues seen this week, the latest first (the desktop's widget). */
export async function GET() {
  return NextResponse.json(await errorsData());
}
