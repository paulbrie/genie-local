import { NextResponse } from "next/server";

import { listDeployments, RailwayError, railwayConfigured } from "@/lib/railway";

export const dynamic = "force-dynamic";

// Railway ids are UUIDs; keep the target to a strict charset (defense in depth —
// the values only ever reach the GraphQL API as variables, never a shell).
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

/** Recent deployments for a service in an environment. `?environmentId=&serviceId=`. */
export async function GET(req: Request) {
  if (!railwayConfigured()) {
    return NextResponse.json({ error: "RAILWAY_API_TOKEN is not set" }, { status: 503 });
  }
  const url = new URL(req.url);
  const environmentId = url.searchParams.get("environmentId") ?? "";
  const serviceId = url.searchParams.get("serviceId") ?? "";
  if (!ID_RE.test(environmentId) || !ID_RE.test(serviceId)) {
    return NextResponse.json({ error: "invalid environmentId/serviceId" }, { status: 400 });
  }
  try {
    const deployments = await listDeployments(environmentId, serviceId);
    return NextResponse.json(
      { deployments },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof RailwayError ? e.message : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
