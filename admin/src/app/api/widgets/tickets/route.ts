import { NextResponse } from "next/server";

import { ticketsData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Tickets: in progress, then to do, across the projects (the desktop's Tickets widget). */
export async function GET() {
  return NextResponse.json(await ticketsData());
}
