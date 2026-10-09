import path from "node:path";

import { NextResponse } from "next/server";

import { getCommsModel, repoFor } from "@/lib/claude-comms";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * The team's tasks for the Tasks board: the comms model (tasks, messages,
 * claims, commits, as the Comms page and Agents City read them; redacted) and
 * each session's project (its repo's top dir, as Agents City groups them).
 * Without the City's tool calls and file layouts, so it stays light to poll.
 *
 * GET /api/team/tasks?hours=24&v=<version>
 *   hours  the time window, 1 h to 30 d
 *   v      unchanged → `{ unchanged: true }`
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hours = Math.min(Math.max(Number(searchParams.get("hours")) || 24, 1), 30 * 24);
  const model = await getCommsModel(hours / 24);
  if (searchParams.get("v") === model.version)
    return NextResponse.json({ unchanged: true, version: model.version }, noStore);
  const projects: Record<string, { id: string; name: string }> = {};
  for (const n of model.nodes) {
    if (!n.cwd) continue;
    const repo = await repoFor(n.cwd).catch(() => null);
    const id = repo?.top ?? n.cwd;
    projects[n.key] = { id, name: path.basename(id) || id };
  }
  // (no tool calls: `activity` is only asked for by the 3D views)
  return NextResponse.json({ ...model, activity: undefined, hours, projects }, noStore);
}
