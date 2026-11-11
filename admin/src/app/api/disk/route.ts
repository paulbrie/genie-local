import { NextResponse } from "next/server";

import { diskOverview } from "@/lib/disk-overview";

export const dynamic = "force-dynamic";

/** The desktop's Disk widget: the filesystem, and /opt/project and /tmp with their largest entries (`?fresh=1` measures again). */
export async function GET(req: Request) {
  return NextResponse.json(await diskOverview(new URL(req.url).searchParams.get("fresh") === "1"));
}
