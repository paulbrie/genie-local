import { NextResponse } from "next/server";

import { cronData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Cron: the crontab's jobs and the system's, each with its next and last run and its log's last line (the desktop's Cron widget). */
export async function GET() {
  return NextResponse.json(await cronData());
}
