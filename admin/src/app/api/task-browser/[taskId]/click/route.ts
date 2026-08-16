import { NextResponse } from "next/server";
import { z } from "zod";

import { VIEWPORT, clickAt } from "@/lib/task-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// Coordinates are normalized 0..1 (fraction of the viewport) so the client
// doesn't need to know the render size — we scale to the real viewport here.
const clickSchema = z.object({
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
});

/** Forward a click at a normalized position into the task's live browser. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const parsed = clickSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "expected { nx, ny } in 0..1" },
      { status: 400, headers: noStore },
    );
  }
  try {
    await clickAt(
      taskId,
      parsed.data.nx * VIEWPORT.width,
      parsed.data.ny * VIEWPORT.height,
    );
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502, headers: noStore },
    );
  }
}
