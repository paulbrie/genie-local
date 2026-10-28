import { NextResponse } from "next/server";

import { db } from "@/db";
import { projects } from "@/db/schema";
import { projectDiskUsage } from "@/lib/disk-usage";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

/**
 * Disk taken by each project folder, by kind (lib/disk-usage), each marked when
 * it's a project the admin knows (so the dashboard links it); `?fresh=1` scans
 * again rather than reuse the last.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const [usage, known] = await Promise.all([
    projectDiskUsage(fresh),
    db.select({ slug: projects.slug }).from(projects).then((rows) => new Set(rows.map((r) => r.slug)), () => new Set<string>()),
  ]);
  return NextResponse.json(
    { ...usage, projects: usage.projects.map((p) => ({ ...p, known: known.has(p.name) })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
