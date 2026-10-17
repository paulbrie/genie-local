// GET: a project's npm scripts per app, each with whether it's running, for
// the sidebar's right-click menu (Scripts ▸).
import { NextRequest, NextResponse } from "next/server";

import { getRunningInfo } from "@/lib/app-run-status";
import { mountPath } from "@/lib/nginx";
import { runSlug } from "@/lib/run-slug";
import { getProjectDetail } from "@/lib/scan";
import { readScripts } from "@/lib/signals";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const detail = await getProjectDetail(slug);
  if (!detail) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const [running, scripts] = await Promise.all([
    getRunningInfo().then((r) => new Set(r.map((x) => x.slug)), () => new Set<string>()),
    Promise.all(detail.apps.map(({ app }) => readScripts(app.path))),
  ]);
  const apps = detail.apps.map(({ app }, i) => ({
    app: app.slug,
    appId: app.id,
    port: app.port,
    // The live app through nginx (as the Scripts tab's "live ↗"), when it has a port.
    url: app.port ? mountPath(slug, app.slug, detail.apps.length === 1) : null,
    scripts: Object.keys(scripts[i]).map((name) => ({
      name,
      running: running.has(runSlug(slug, app.slug, name)),
    })),
  }));
  return NextResponse.json({ apps }, { headers: { "Cache-Control": "no-store" } });
}
