import { NextResponse } from "next/server";

import { runUpdate, updateStatus } from "@/lib/admin-update";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

/** What GitHub has that this admin doesn't. Polled by the toolbar. */
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await updateStatus(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * Pull it and ship it. Takes as long as the install does, then hands over to
 * the deploy, which restarts this very app — so the caller should expect the
 * connection to drop shortly after a successful reply.
 */
export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runUpdate();
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
