import { NextResponse } from "next/server";

import { listProjects, RailwayError, railwayConfigured } from "@/lib/railway";

export const dynamic = "force-dynamic";

/** Every Railway project in the connected workspace (with services + envs). */
export async function GET() {
  if (!railwayConfigured()) {
    return NextResponse.json(
      { configured: false, projects: [], error: "RAILWAY_API_TOKEN is not set" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const projects = await listProjects();
    return NextResponse.json(
      { configured: true, projects },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof RailwayError ? e.message : (e as Error).message;
    return NextResponse.json(
      { configured: true, projects: [], error: msg },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
