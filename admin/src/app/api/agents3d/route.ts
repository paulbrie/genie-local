import { NextResponse } from "next/server";

import type { Agents3DResponse } from "@/lib/agents3d-types";
import { getAgents3DModel } from "@/lib/agents3d";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Data for the 3D agents views. Redacted messages (as /api/claude/comms), tool
 * calls per session (tool name, time, repo-relative path for Edit/Write/Read)
 * and repo layouts.
 *
 * GET /api/agents3d?hours=8&v=<version>&rv=<reposVersion>&since=<iso>
 *   hours  the time window, 1 h to 30 d (or days=, the older form)
 *   v      unchanged → `{ unchanged: true }`
 *   rv     repos unchanged → `repos: null`
 *   since  only tool calls at or after this time (`partial: true`)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hours = Number(searchParams.get("hours")) || (Number(searchParams.get("days")) || 1) * 24;
  const days = Math.min(Math.max(hours, 1), 30 * 24) / 24;
  const model = await getAgents3DModel(days);
  if (searchParams.get("v") === model.version)
    return NextResponse.json({ unchanged: true, version: model.version } satisfies Agents3DResponse, noStore);

  const since = searchParams.get("since");
  const activity = since
    ? Object.fromEntries(
        Object.entries(model.activity).map(([k, ev]) => [k, ev.filter((e) => e.t >= since)]),
      )
    : model.activity;
  const body: Agents3DResponse = {
    version: model.version,
    reposVersion: model.reposVersion,
    comms: model.comms,
    activity,
    nodeRepos: model.nodeRepos,
    partial: !!since,
    repos: searchParams.get("rv") === model.reposVersion ? null : model.repos,
  };
  return NextResponse.json(body, noStore);
}
