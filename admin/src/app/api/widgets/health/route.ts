import { NextResponse } from "next/server";

import { healthData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Health: the curated services and the containers, the ones that need you first (the desktop's Health widget). */
export async function GET() {
  return NextResponse.json(await healthData());
}
