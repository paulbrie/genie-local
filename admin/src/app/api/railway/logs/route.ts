import { NextResponse } from "next/server";

import {
  DEFAULT_LOG_LINES,
  getDeploymentLogs,
  RailwayError,
  railwayConfigured,
} from "@/lib/railway";

export const dynamic = "force-dynamic";

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

/**
 * Logs for one deployment. `?deploymentId=<id>&limit=<n>&filter=<railway-filter>`.
 * `filter` is Railway's native log-filter syntax; omit for everything.
 */
export async function GET(req: Request) {
  if (!railwayConfigured()) {
    return NextResponse.json({ error: "RAILWAY_API_TOKEN is not set" }, { status: 503 });
  }
  const url = new URL(req.url);
  const deploymentId = url.searchParams.get("deploymentId") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? String(DEFAULT_LOG_LINES));
  const filter = url.searchParams.get("filter");
  if (!ID_RE.test(deploymentId)) {
    return NextResponse.json({ error: "invalid deploymentId" }, { status: 400 });
  }
  try {
    const logs = await getDeploymentLogs(
      deploymentId,
      Number.isFinite(limit) ? limit : DEFAULT_LOG_LINES,
      filter,
    );
    return NextResponse.json({ logs }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof RailwayError ? e.message : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
