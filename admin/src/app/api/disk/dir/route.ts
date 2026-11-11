import { NextResponse } from "next/server";

import { diskDir } from "@/lib/disk-overview";
import { PathError } from "@/lib/files/guard";

export const dynamic = "force-dynamic";

/** A folder drilled into from the Disk widget's treemap (`?path=`): its entries and theirs, by size; within the Files explorer's roots. */
export async function GET(req: Request) {
  const asked = new URL(req.url).searchParams.get("path") ?? "";
  try {
    return NextResponse.json({ asked, ...(await diskDir(asked)) });
  } catch (err) {
    const status = err instanceof PathError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
