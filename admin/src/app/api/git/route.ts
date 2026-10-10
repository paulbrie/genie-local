import { NextResponse } from "next/server";

import { getGraph, listRepos, resolveRepo } from "@/lib/git-graph";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * The commit graph for one project's repo. `project` is required; `app` selects
 * which repo when the project holds several (defaults to the first). Returns the
 * list of repos too, so the UI can offer a picker.
 *
 * GET /api/git?project=<slug>&app=<appSlug>
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project");
  const appParam = searchParams.get("app");
  if (!project)
    return NextResponse.json({ error: "project required" }, { status: 400 });

  let repos;
  try {
    repos = await listRepos(project);
  } catch {
    return NextResponse.json({ error: "invalid project" }, { status: 400 });
  }
  if (repos.length === 0)
    return NextResponse.json({ error: "no git repo" }, { status: 404 });

  // Default to the first repo when no (or an unknown) app is requested.
  const app = repos.some((r) => r.app === appParam)
    ? (appParam as string)
    : repos[0].app;

  const repoDir = await resolveRepo(project, app);
  if (!repoDir)
    return NextResponse.json({ error: "no git repo" }, { status: 404 });

  const graph = await getGraph(repoDir);
  return NextResponse.json({ repos, app, graph }, noStore);
}
