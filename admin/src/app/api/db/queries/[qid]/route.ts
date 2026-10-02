import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/db-route-helpers";
import { deleteSavedQuery } from "@/lib/saved-queries";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ qid: string }> },
) {
  try {
    const qid = z.coerce.number().int().positive().parse((await params).qid);
    await deleteSavedQuery(qid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
