import { NextResponse } from "next/server";

import { signinsData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Sign-ins: who's connected now, and the sign-ins that failed today (the desktop's widget). */
export async function GET() {
  return NextResponse.json(await signinsData());
}
