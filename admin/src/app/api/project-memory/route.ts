import { NextResponse } from "next/server";
import { z } from "zod";

import { projectMemoryStatus, setMemoryLimit } from "@/lib/project-memory";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

/**
 * What each project has in memory now (its processes, by script, and its
 * containers), the limits to warn above, and the server's total and available
 * memory. Polled every few seconds by <ProjectMemoryMonitor>; measured at most
 * every 4 s however many tabs ask.
 */
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await projectMemoryStatus(), { headers: { "Cache-Control": "no-store" } });
}

const limitSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  // MB; null clears it
  limitMb: z.number().int().min(64).max(1024 * 1024).nullable(),
});

/** Set or clear a project's limit: `{ slug, limitMb }`. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = limitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  const ok = await setMemoryLimit(parsed.data.slug, parsed.data.limitMb);
  if (!ok) return NextResponse.json({ error: "no such project" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
