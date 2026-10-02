import { NextResponse } from "next/server";

import { scanAndPersist } from "@/lib/scan";

export const dynamic = "force-dynamic";

/** Trigger a full rescan of all projects (e.g. from a cron job). */
export async function POST() {
  const signals = await scanAndPersist();
  return NextResponse.json({
    ok: true,
    scannedProjects: signals.length,
    scannedApps: signals.reduce((n, p) => n + p.apps.length, 0),
    projects: signals.map((p) => ({
      slug: p.slug,
      apps: p.apps.map((a) => ({
        slug: a.slug,
        name: a.name,
        branch: a.git.branch,
        dirty: a.git.dirty,
        errors: a.errors,
      })),
    })),
  });
}
