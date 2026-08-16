import { NextResponse } from "next/server";
import { z } from "zod";

import { VIEWPORT, getStreamPort, openUrl } from "@/lib/task-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** Current stream readiness for the task's browser. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const port = await getStreamPort(taskId);
  return NextResponse.json(
    { ready: port !== null, viewport: VIEWPORT },
    { headers: noStore },
  );
}

const openSchema = z.object({ url: z.string().url() });

/** Open (or navigate) the task's browser to a URL, launching it if needed. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const parsed = openSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "expected { url: <http(s) url> }" },
      { status: 400, headers: noStore },
    );
  }
  try {
    await openUrl(taskId, parsed.data.url);
    const port = await getStreamPort(taskId);
    return NextResponse.json(
      { ok: true, ready: port !== null, viewport: VIEWPORT },
      { headers: noStore },
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502, headers: noStore },
    );
  }
}
