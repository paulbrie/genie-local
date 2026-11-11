import { NextResponse } from "next/server";

import { dockerData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Docker: every container with its CPU and memory, and the images (the desktop's Docker widget). */
export async function GET() {
  return NextResponse.json(await dockerData());
}
